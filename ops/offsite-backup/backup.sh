#!/usr/bin/env bash
# Daily encrypted logical backup of the AMQUR production database to an S3-compatible bucket
# (a Railway Bucket in the same project), with read-back verification and retention.
#
# Required variables (Railway, sealed):
#   BACKUP_DATABASE_URL   connection string for a READ-ONLY backup role (never the app's role)
#   BACKUP_PASSPHRASE     encryption passphrase (also kept in the owner's password manager)
#   BACKUP_BUCKET         bucket name
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_ENDPOINT_URL / AWS_DEFAULT_REGION   bucket credentials
# Optional:
#   BACKUP_ALERT_WEBHOOK_URL   https endpoint that receives a failure notice (no data)
#   BACKUP_KEEP_DAILY (30), BACKUP_KEEP_MONTHLY (12)
#
# The dump is encrypted in the pipe before it is written anywhere. Nothing is printed except
# sizes, hashes and counts. Exit code ≠ 0 on any failure.
set -euo pipefail
umask 077
: "${BACKUP_DATABASE_URL:?}" "${BACKUP_PASSPHRASE:?}" "${BACKUP_BUCKET:?}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-30}"
KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-12}"
STAMP="$(date -u +%Y-%m-%dT%H%MZ)"
DAY="$(date -u +%d)"
KIND="daily"; [ "$DAY" = "01" ] && KIND="monthly"
KEY="amqur-prod/${KIND}/amqur-prod-${STAMP}.dump.enc"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export PASS="$BACKUP_PASSPHRASE"

fail() {
  echo "BACKUP FAILED: $1" >&2
  if [ -n "${BACKUP_ALERT_WEBHOOK_URL:-}" ]; then
    curl -fsS -m 10 -H 'Content-Type: application/json' \
      -d "{\"text\":\"AMQUR production backup failed: $1 ($STAMP)\"}" "$BACKUP_ALERT_WEBHOOK_URL" >/dev/null || true
  fi
  exit 1
}

pg_dump --dbname="$BACKUP_DATABASE_URL" -Fc -Z 6 \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:PASS -out "$WORK/b.enc" \
  || fail "dump_or_encrypt"
SIZE="$(stat -c %s "$WORK/b.enc")"; SHA="$(sha256sum "$WORK/b.enc" | cut -c1-64)"
[ "$SIZE" -gt 1000 ] || fail "dump_too_small"

aws s3 cp "$WORK/b.enc" "s3://$BACKUP_BUCKET/$KEY" --only-show-errors --metadata "sha256=$SHA" || fail "upload"

# Read-back verification: download, compare hash, decrypt, and let pg_restore read every object.
aws s3 cp "s3://$BACKUP_BUCKET/$KEY" "$WORK/v.enc" --only-show-errors || fail "download"
[ "$(sha256sum "$WORK/v.enc" | cut -c1-64)" = "$SHA" ] || fail "hash_mismatch"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:PASS -in "$WORK/v.enc" -out "$WORK/v.dump" || fail "decrypt"
pg_restore -f /dev/null "$WORK/v.dump" || fail "restore_read"
TABLES="$(pg_restore -l "$WORK/v.dump" | grep -c 'TABLE DATA' || true)"
[ "$TABLES" -gt 10 ] || fail "too_few_tables"

# Retention: keep the newest N of each kind.
prune() {
  # An empty prefix makes `aws s3 ls` exit 1; that means "nothing to prune", not a failure.
  { aws s3 ls "s3://$BACKUP_BUCKET/amqur-prod/$1/" || true; } | awk '{print $4}' | sort | head -n "-$2" \
    | while read -r f; do [ -n "$f" ] && aws s3 rm "s3://$BACKUP_BUCKET/amqur-prod/$1/$f" --only-show-errors; done
  return 0
}
prune daily "$KEEP_DAILY"; prune monthly "$KEEP_MONTHLY"

echo "BACKUP OK key=$KEY bytes=$SIZE sha256=$SHA table_data=$TABLES"
