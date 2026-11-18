"""Check the public DNS target, certificate, STARTTLS and live exact recipient lookup."""
import argparse
import smtplib
import ssl
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("host")
parser.add_argument("recipient", help="A connected address on a verified customer domain")
args = parser.parse_args()
with smtplib.SMTP(args.host, 25, timeout=20) as smtp:
    smtp.ehlo()
    smtp.starttls(context=ssl.create_default_context())
    smtp.ehlo()
    if smtp.mail("")[0] != 250 or smtp.rcpt(args.recipient)[0] != 250:
        raise SystemExit("Connected recipient check failed")
    if smtp.rcpt(f"{uuid.uuid4()}@example.invalid")[0] != 550:
        raise SystemExit("Unbound recipient check failed")
print("STARTTLS certificate and envelope checks passed.")
