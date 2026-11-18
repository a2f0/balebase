# Balebase SMTP receiver

This service receives mail on TCP port 25 for verified customer domains.
Senders may use STARTTLS. The service validates each envelope recipient with
the Balebase Worker, including recipients omitted from the message headers.
After DATA, a SQLite transaction persists the original bytes, a Received
trace, and each recipient's accepted mailbox ID before replying 250.
The queue retries the authenticated HTTPS delivery after a restart or
temporary failure. Each accepted recipient has its own delivery UUID.
An acknowledgment lost between servers can cause a sending MTA to submit a
second SMTP transaction, as with other SMTP receivers.

## Quick start

1. Provide a dedicated Linux systemd host per tier with Python 3.11 or newer
   and its venv/pip package, persistent disk larger than 4 GiB, public
   inbound TCP/25, outbound HTTPS, and a working clock. The service needs
   no outbound SMTP. Production uses `mx.balebase.com`, staging uses
   `mx-staging.balebase.com`. Confirm the host/network provider allows port 25.
2. Apply Worker migrations 0105 and 0106. Configure a random, tier-specific
   `SMTP_INGRESS_TOKEN` (at least 32 characters) in the API Worker secrets
   and deploy the API. Put the identical value in
   `/etc/balebase-smtp/bridge-token` on this tier's receiver.
   Provision a publicly trusted certificate for its hostname, such as via
   ACME DNS-01. Put the certificate chain and private key in
   `/etc/balebase-smtp/fullchain.pem` and `privkey.pem`. Keep the directory
   and private credentials root-only.
3. From this repository on that host, run
   `sudo bash smtp/install.sh staging` or `sudo bash smtp/install.sh prod`.
   The installer enables the systemd unit. It preserves its private spool
   under `/var/lib/balebase-smtp` across upgrades. Restart the service
   after rotating its token or renewing the certificate.
4. Set `TF_VAR_smtp_ipv4` and/or `TF_VAR_smtp_ipv6` to the receiver's public
   addresses in the corresponding tier environment. Review and apply that
   tier's Terraform DNS changes. These DNS-only A/AAAA records publish the
   host. Advertise only address families that accept public TCP/25.
5. Verify a customer test domain by TXT in **Inbox → Manage inbox addresses**
   and connect a recipient. Leave its verification TXT in DNS while using
   direct delivery. Each SMTP recipient check revalidates this proof. A
   missing or mismatched TXT or unavailable DNS produces a retryable SMTP
   error before the receiver accepts that recipient. From another network run
   `python3 smtp/check.py mx-staging.balebase.com legal@example.org` using
   that recipient and the tier's hostname. It checks the certificate and
   exact recipient acceptance and rejection without sending a message.
   Set `SMTP_ADVERTISE_MX=1` in that tier and redeploy the API after the
   check passes. Its UI now offers direct MX with preference 10 alongside
   each address's forwarding destination.
6. At the customer DNS provider, point MX for the **exact verified domain**
   to the displayed host with preference 10. This directs every recipient on
   that domain here. Use a dedicated subdomain when the parent domain
   continues receiving mail elsewhere. Verify the records in the UI, then
   send an external message to each connected recipient. Verify its subject
   and attachment through the named inbox. Per-address forwarding through
   the existing mail provider continues to work for the same binding.

## Operations

`systemctl status balebase-smtp` checks the service. Monitor TLS expiration,
disk usage, the public SMTP probe, and queue state. On the host, run
`sudo /opt/balebase-smtp/venv/bin/python -B /opt/balebase-smtp/receiver.py status`
to get queued and held recipient counts. Status does not print message contents.
Take encrypted filesystem snapshots of the persistent spool for recovery.
Only restore the spool to the same tier.

Queue retries back off to once per hour. Investigate growing queues,
especially after Worker deploys or token rotations. After restoring the
service the queue drains automatically. A permanent failure, such as a
recipient disconnected after SMTP acceptance, holds that recipient's local
copy for operator investigation. Review the delivery UUID, mailbox ID, last
HTTP status and attempt count in the local `deliveries` table; access the
spool as customer data. A new address binding has a different mailbox ID.
The receiver never redirects previously accepted mail to that binding.
Successful deliveries release their local bodies when all recipients finish.
For held deliveries, arrange recovery with the original workspace's operator.
After an authorized workspace purge, run the following on this tier's receiver.
It permanently deletes that organization's held recipients and releases a body
once every recipient has finished. Queued deliveries and other tenants' held
recipients remain available.

```sh
sudo /opt/balebase-smtp/venv/bin/python -B /opt/balebase-smtp/receiver.py discard-held --organization ORGANIZATION_ID
```

To retire a receiver, remove its customer MX instructions by disabling
`SMTP_ADVERTISE_MX` and redeploying the API. Migrate customer DNS or
forwarding, keep the listener for cached MX and in-flight retries, and drain or
recover all queued mail before retiring its address records, disk and token.
