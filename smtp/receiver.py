"""Balebase inbound SMTP. The only delivery transport is the tier's HTTPS Worker."""
import asyncio
from email.utils import formatdate
import ipaddress
import http.client
import json
import logging
import os
import sqlite3
import ssl
import sys
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

from aiosmtpd.smtp import SMTP
from spool import Spool

MAX_BYTES = 25 * 1024 * 1024 - 512  # reserve space for the Received trace


class Bridge:
    def __init__(self, origin, token):
        url = urlsplit(origin)
        local = url.hostname in ("localhost", "127.0.0.1", "::1")
        if (url.scheme != "https" and not (url.scheme == "http" and local)) or not url.hostname:
            raise ValueError("The Worker bridge requires HTTPS")
        if url.username or url.password or url.path not in ("", "/") or url.query or url.fragment:
            raise ValueError("Expected the Worker origin")
        if len(token) < 32:
            raise ValueError("Configure the SMTP ingress credential")
        self.url = url
        self.token = token

    def __call__(self, route, address, body=b"", extra=None):
        conn_type = http.client.HTTPSConnection if self.url.scheme == "https" else http.client.HTTPConnection
        conn = conn_type(self.url.hostname, self.url.port, timeout=15 if route == "recipient" else 120)
        try:
            conn.request("POST", "/internal/inbound-smtp/" + route, body, {
                "Authorization": "Bearer " + self.token, "X-Inbound-Recipient": address,
                "Content-Type": "message/rfc822", **(extra or {}),
            })
            response = conn.getresponse()
            return response.status, response.read(1024)
        except (OSError, http.client.HTTPException):
            return 503, b""
        finally:
            conn.close()


class Receiver:
    def __init__(self, spool, bridge):
        self.spool = spool
        self.bridge = bridge

    async def handle_RCPT(self, server, session, envelope, address, options):
        address = address.lower()
        if len(address) > 254 or not address.isascii() or any(ord(c) < 33 or ord(c) == 127 for c in address):
            return "550 5.1.3 Invalid recipient"
        if options:
            return "555 5.5.4 Unsupported recipient option"
        if len(envelope.rcpt_tos) >= 100:
            return "452 4.5.3 Too many recipients"
        status, data = await asyncio.to_thread(self.bridge, "recipient", address)
        if status == 404:
            return "550 5.1.1 Unknown recipient"
        if status != 200:
            return "451 4.3.0 Recipient verification unavailable"
        try:
            mailbox = str(UUID(json.loads(data)["mailboxId"]))
        except (ValueError, TypeError, KeyError):
            return "451 4.3.0 Invalid verification response"
        if not hasattr(envelope, "bindings"):
            envelope.bindings = {}
        if address not in envelope.bindings:
            envelope.rcpt_tos.append(address)
            envelope.bindings[address] = mailbox
        return "250 2.1.5 Recipient accepted"

    async def handle_DATA(self, server, session, envelope):
        # SMTPUTF8 is disabled. Keep envelope fields safe for HTTP headers,
        # including the null reverse path used by delivery status messages.
        sender = "" if envelope.mail_from == "<>" else envelope.mail_from
        if len(sender) > 254 or not sender.isascii() or any(ord(c) < 32 or ord(c) == 127 for c in sender):
            return "550 5.1.7 Invalid sender"
        peer = ipaddress.ip_address(session.peer[0])
        protocol = "ESMTPS" if session.ssl else "ESMTP"
        trace = f"Received: from [{peer}] by {server.hostname} with {protocol}; {formatdate(localtime=False, usegmt=True)}\r\n"
        try:
            await asyncio.to_thread(self.spool.accept, sender, trace.encode("ascii") + envelope.original_content, envelope.bindings)
        except (sqlite3.Error, OSError):
            logging.error("SMTP spool write failed")
            return "452 4.3.1 Cannot durably queue message"
        return "250 2.0.0 Message queued"


async def serve(handler, hostname, host, port, tls):
    active = set()

    class LimitedSMTP(SMTP):
        def connection_made(self, transport):
            if self not in active and len(active) >= 8:
                transport.write(b"421 4.3.2 Server busy\r\n")
                transport.close()
                return
            active.add(self)
            super().connection_made(transport)

        def connection_lost(self, error):
            if self in active:
                active.discard(self)
                super().connection_lost(error)

    def protocol():
        return LimitedSMTP(handler, hostname=hostname, tls_context=tls, require_starttls=False,
                           decode_data=False, enable_SMTPUTF8=False, timeout=120,
                           auth_exclude_mechanism={"LOGIN", "PLAIN"}, data_size_limit=MAX_BYTES,
                           command_call_limit={"RCPT": 200, "*": 30})
    return await asyncio.get_running_loop().create_server(protocol, host=host, port=port, backlog=64)


async def main(spool):
    credentials = Path(os.environ["CREDENTIALS_DIRECTORY"])
    bridge = Bridge(os.environ["SMTP_API_ORIGIN"], (credentials / "bridge-token").read_text().strip())
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.minimum_version = ssl.TLSVersion.TLSv1_2
    tls.load_cert_chain(credentials / "fullchain.pem", credentials / "privkey.pem")
    server = await serve(Receiver(spool, bridge), os.environ["SMTP_HOSTNAME"],
                         os.environ.get("SMTP_BIND") or None, int(os.environ.get("SMTP_PORT", 25)), tls)
    async with server:
        while True:
            # Single consumer. A crash after delivery retries the same UUID.
            if not await asyncio.to_thread(spool.deliver_one, bridge):
                await asyncio.sleep(1)


if __name__ == "__main__":
    os.umask(0o077)
    spool = Spool(Path(os.environ.get("STATE_DIRECTORY", "/var/lib/balebase-smtp")) / "spool.sqlite")
    if sys.argv[1:] == ["status"]:
        print(json.dumps(spool.counts()))
    else:
        asyncio.run(main(spool))
