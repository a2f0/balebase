"""Drive a real SMTP session and retry its durable queue against a local Worker."""
import asyncio
import os
import smtplib
import sqlite3
import ssl
import sys
from contextlib import closing, ExitStack
from pathlib import Path

from receiver import Bridge, Receiver, serve
from spool import Spool, SpoolUnavailable


async def run():
    origin, work = sys.argv[1:]
    work = Path(work)
    bridge = Bridge(origin, os.environ["SMTP_TEST_TOKEN"])
    auth_status, _ = Bridge(origin, "x" * 32)("recipient", "legal@base.example.org")
    assert auth_status == 401
    spool_file = work / "spool.sqlite"
    spool = Spool(spool_file)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(work / "cert.pem", work / "key.pem")
    host = "localhost"
    validation_outage = False
    def validate_or_deliver(route, *args):
        if route == "validate" and validation_outage:
            return 503, b""
        return bridge(route, *args)
    server = await serve(Receiver(spool, validate_or_deliver), host, "127.0.0.1", 0, ctx)
    port = server.sockets[0].getsockname()[1]

    def submit():
        with smtplib.SMTP(host, port, timeout=10) as smtp:
            smtp.ehlo()
            smtp.starttls(context=ssl.create_default_context(cafile=str(work / "cert.pem")))
            smtp.ehlo()
            assert smtp.mail("")[0] == 250
            for invalid in ("missing@base.example.org", "legal@unverified.example.org", "legal@balebase.com"):
                assert smtp.rcpt(invalid)[0] == 550, invalid
            assert smtp.rcpt("legal@base.example.org")[0] == 250
            assert smtp.rcpt("accounts@base.example.org")[0] == 250
            code, _ = smtp.data(b"To: unrelated@example.net\r\nSubject: SMTP delivery\r\n"
                b'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="p"\r\n\r\n'
                b'--p\r\nContent-Type: text/plain\r\n\r\n.Hello\r\n--p\r\nContent-Type: text/plain\r\n'
                b'Content-Disposition: attachment; filename="a.txt"\r\n\r\nattachment body\r\n--p--\r\n')
            assert code == 250
    async with server:
        def connection_limit():
            with ExitStack() as stack:
                for _ in range(4):
                    stack.enter_context(smtplib.SMTP(host, port, timeout=10))
                try:
                    smtplib.SMTP(host, port, timeout=10)
                except smtplib.SMTPConnectError as error:
                    assert error.smtp_code == 421
                else:
                    raise AssertionError("Per-source connection limit was not enforced")
        await asyncio.to_thread(connection_limit)
        await asyncio.to_thread(submit)
        def try_data(content):
            with smtplib.SMTP(host, port, timeout=10) as smtp:
                smtp.ehlo()
                assert smtp.mail("")[0] == 250
                assert smtp.rcpt("legal@base.example.org")[0] == 250
                return smtp.data(content)[0]
        invalid = b'Content-Type: multipart/mixed; boundary="p"\r\n\r\n' + b"--p\r\n\r\npart\r\n" * 1200 + b"--p--\r\n"
        assert await asyncio.to_thread(try_data, invalid) == 554
        validation_outage = True
        assert await asyncio.to_thread(try_data, b"Subject: retry\r\n\r\nbody") == 451
        validation_outage = False
        assert spool.counts() == {"queued": 2}
        spool.quota_bytes = 25 * 1024 * 1024 + 4096
        def over_quota():
            with smtplib.SMTP(host, port, timeout=10) as smtp:
                smtp.ehlo()
                assert smtp.mail("")[0] == 250
                assert smtp.rcpt("legal@base.example.org")[0] == 452
                assert smtp.rcpt("legal@other.example.org")[0] == 250
                with smtplib.SMTP(host, port, timeout=10) as competing:
                    competing.ehlo()
                    assert competing.mail("")[0] == 250
                    assert competing.rcpt("legal@other.example.org")[0] == 452
                    assert smtp.rset()[0] == 250
                    assert competing.rcpt("legal@other.example.org")[0] == 250
                # Disconnecting releases the new connection's reservation too.
                assert smtp.mail("")[0] == 250
                assert smtp.rcpt("legal@base.example.org")[0] == 452
                assert smtp.rcpt("legal@other.example.org")[0] == 250
                assert smtp.data("Subject: other workspace\r\n\r\nbody")[0] == 250
        await asyncio.to_thread(over_quota)
    deadline_server = await serve(Receiver(spool, bridge), host, "127.0.0.1", 0, ctx, session_seconds=0.2)
    async with deadline_server:
        reader, writer = await asyncio.open_connection("127.0.0.1", deadline_server.sockets[0].getsockname()[1])
        assert (await reader.readline()).startswith(b"220 ")
        assert await asyncio.wait_for(reader.read(), timeout=5) == b""
        writer.close()
        await writer.wait_closed()
    # Reopen from disk as a restarted receiver does. Lose the first successful
    # HTTP response and then replay all deliveries with their persisted IDs.
    spool = Spool(spool_file)
    assert spool.counts() == {"queued": 3}
    def lost_ack(*args):
        status, _ = bridge(*args)
        assert status == 204, status
        return 503, b""
    assert spool.deliver_one(lost_ack)
    with closing(sqlite3.connect(spool_file)) as db, db:
        db.execute("UPDATE deliveries SET due=0")
    while spool.deliver_one(bridge):
        pass
    assert spool.counts() == {}
    # An address that was disconnected after acceptance cannot silently move
    # into a freshly provisioned mailbox. The queue retains its original body.
    spool.accept("", b"Subject: Old binding\r\n\r\nold", {
        "legal@base.example.org": ("d0acf8b3-4c04-4570-bf98-f3bd56ea037c", "purged-org"),
        "legal@another.example.org": ("8cbaf370-8eee-4264-ab1f-bac0aed5d1db", "another-org"),
    })
    assert spool.deliver_one(bridge)
    assert spool.deliver_one(bridge)
    assert spool.counts() == {"held": 2}
    spool.accept("", b"later", {"x@base.example.org": ("future-retry", "purged-org")})
    with closing(sqlite3.connect(spool_file)) as db, db:
        db.execute("UPDATE deliveries SET due=2147483647 WHERE state='queued'")
    assert spool.purge_organization("purged-org") == 2
    try:
        spool.accept("", b"in flight", {"x@base.example.org": ("stale", "purged-org")})
    except SpoolUnavailable:
        pass
    else:
        raise AssertionError("purged workspace accepted an in-flight delivery")
    assert spool.counts() == {"held": 1}
    with closing(sqlite3.connect(spool_file)) as db:
        assert db.execute("SELECT body FROM messages").fetchone()[0].endswith(b"old")
    print("SMTP STARTTLS, durable DATA, replay and disconnected binding passed")


asyncio.run(run())
