#!/usr/bin/env bash
set -euo pipefail
umask 022
case "${1:-}" in
  prod) hostname=mx.balebase.com; api=https://api.balebase.com ;;
  staging) hostname=mx-staging.balebase.com; api=https://api-staging.balebase.com ;;
  *) echo "Usage: sudo bash smtp/install.sh prod|staging" >&2; exit 2 ;;
esac
source_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
config=/etc/balebase-smtp
target=/opt/balebase-smtp
for file in bridge-token privkey.pem fullchain.pem; do
  [[ -s "$config/$file" ]] || { echo "Provide $config/$file before installing." >&2; exit 1; }
done
if [[ -s "$config/receiver.env" ]] && ! grep -qxF "SMTP_HOSTNAME=$hostname" "$config/receiver.env"; then
  echo 'Use a separate SMTP machine and spool for each tier.' >&2
  exit 1
fi
install -d -m 0755 "$target"
python3 -m venv "$target/venv"
"$target/venv/bin/python" -m pip install --disable-pip-version-check --only-binary=:all: --require-hashes -r "$source_dir/requirements.txt"
install -m 0644 "$source_dir"/{receiver.py,spool.py} "$target/"
printf 'SMTP_HOSTNAME=%s\nSMTP_API_ORIGIN=%s\n' "$hostname" "$api" > "$config/receiver.env"
install -m 0644 "$source_dir/balebase-smtp.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable balebase-smtp.service
systemctl restart balebase-smtp.service
systemctl is-active --quiet balebase-smtp.service
