"""SQLite is the SMTP acceptance boundary. Each RCPT keeps its original binding."""

import sqlite3
import time
import uuid
from contextlib import closing
from collections import Counter


class SpoolUnavailable(Exception):
    pass


class Spool:
    def __init__(self, path, quota_bytes=256 * 1024 * 1024):
        self.path = path
        self.quota_bytes = quota_bytes
        with closing(self.connect()) as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY, sender TEXT NOT NULL, body BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS deliveries (
                    id TEXT PRIMARY KEY, message INTEGER NOT NULL REFERENCES messages(id),
                    address TEXT NOT NULL, mailbox TEXT NOT NULL, organization TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                    due INTEGER NOT NULL DEFAULT 0, status INTEGER,
                    state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','held')));
                CREATE TABLE IF NOT EXISTS retired_organizations (id TEXT PRIMARY KEY);
                CREATE INDEX IF NOT EXISTS deliveries_org ON deliveries(organization,message);
                CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(state, due);
                CREATE INDEX IF NOT EXISTS deliveries_message ON deliveries(message);
                CREATE TRIGGER IF NOT EXISTS release_body AFTER DELETE ON deliveries
                WHEN NOT EXISTS (SELECT 1 FROM deliveries WHERE message=old.message)
                BEGIN DELETE FROM messages WHERE id=old.message; END;
            """)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA secure_delete=ON")
        db.execute("PRAGMA synchronous=FULL")
        # Refuse new mail before the spool can consume all host storage.
        db.execute("PRAGMA max_page_count=1048576")
        return db

    def accept(self, sender, body, recipients):
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            for org, count in Counter(org for _, org in recipients.values()).items():
                # Charge each retained body once per tenant, plus 4 KiB per recipient.
                used = db.execute("""
                    SELECT (SELECT COUNT(*) * 4096 FROM deliveries WHERE organization=?) +
                      COALESCE(SUM(length(body)),0)
                    FROM messages WHERE id IN (SELECT message FROM deliveries WHERE organization=?)
                """, (org,org)).fetchone()[0]
                if db.execute("SELECT 1 FROM retired_organizations WHERE id=?", (org,)).fetchone():
                    raise SpoolUnavailable("Workspace retired")
                if used + len(body) + count * 4096 > self.quota_bytes:
                    raise SpoolUnavailable("Workspace spool limit")
            message = db.execute("INSERT INTO messages(sender,body) VALUES (?,?)", (sender, body)).lastrowid
            db.executemany(
                "INSERT INTO deliveries(id,message,address,mailbox,organization) VALUES (?,?,?,?,?)",
                [(str(uuid.uuid4()), message, address, mailbox, org) for address, (mailbox, org) in recipients.items()],
            )

    def deliver_one(self, bridge):
        with closing(self.connect()) as db:
            row = db.execute("""
                SELECT d.id, d.address, d.mailbox, d.attempts, m.sender, m.body
                FROM deliveries d JOIN messages m ON m.id=d.message
                WHERE d.state='queued' AND d.due<=? ORDER BY d.due,d.rowid LIMIT 1
            """, (int(time.time()),)).fetchone()
            if row is None:
                return False
            status, _ = bridge("deliver", row["address"], row["body"], {
                "X-Inbound-Mailbox": row["mailbox"], "X-Inbound-Delivery": row["id"],
                "X-Inbound-Sender": row["sender"],
            })
            with db:
                if status == 204:
                    db.execute("DELETE FROM deliveries WHERE id=? AND state='queued'", (row["id"],))
                elif status in (400, 410, 413, 422):
                    # Retain permanently undeliverable accepted mail for inspection.
                    db.execute("UPDATE deliveries SET state='held',status=? WHERE id=? AND state='queued'", (status, row["id"]))
                else:
                    wait = min(3600, 5 * 2 ** min(row["attempts"], 10))
                    db.execute("UPDATE deliveries SET due=?,attempts=attempts+1,status=? WHERE id=? AND state='queued'",
                               (int(time.time()) + wait, status, row["id"]))
            return True

    def purge_organization(self, organization):
        with closing(self.connect()) as db, db:
            # Fence DATA sessions whose RCPT was accepted just before the purge.
            db.execute("INSERT OR IGNORE INTO retired_organizations(id) VALUES (?)", (organization,))
            return db.execute("DELETE FROM deliveries WHERE organization=?", (organization,)).rowcount

    def counts(self):
        with closing(self.connect()) as db:
            return dict(db.execute("SELECT state,COUNT(*) FROM deliveries GROUP BY state"))
