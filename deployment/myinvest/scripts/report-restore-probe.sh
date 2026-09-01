#!/usr/bin/env bash
set -Eeuo pipefail

receipt_path="${1:-}"
endpoint="${2:-${SUPPORT_RESTORE_PROBE_ENDPOINT:-}}"
[[ -n "$receipt_path" && -f "$receipt_path" && -n "$endpoint" ]] || {
  printf 'Usage: SUPPORT_RESTORE_PROBE_SECRET=... %s <offsite-receipt.json> <https-endpoint>\n' "$0" >&2
  exit 1
}
case "$endpoint" in
  https://*/api/internal/support-restore-probe) ;;
  *)
    printf 'Restore probe endpoint must be HTTPS and use /api/internal/support-restore-probe.\n' >&2
    exit 1
    ;;
esac
[[ ${#SUPPORT_RESTORE_PROBE_SECRET} -ge 32 && ${#SUPPORT_RESTORE_PROBE_SECRET} -le 512 ]] || {
  printf 'SUPPORT_RESTORE_PROBE_SECRET must contain 32 to 512 characters.\n' >&2
  exit 1
}
for command_name in curl jq python3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf '%s is required for restore probe reporting.\n' "$command_name" >&2
    exit 1
  }
done

snapshot="$(jq -er '.snapshot | select(type == "string" and test("^20[0-9]{6}T[0-9]{6}Z$"))' "$receipt_path")"
set +e
"$(dirname "$0")/verify-offsite-backup.sh" "$receipt_path"
probe_exit=$?
set -e
if [[ $probe_exit -eq 0 ]]; then
  probe_ok=true
else
  probe_ok=false
fi
checked_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
body="$(jq -cn \
  --arg snapshot "$snapshot" \
  --arg checked_at "$checked_at" \
  --argjson ok "$probe_ok" \
  '{snapshot:$snapshot,ok:$ok,checkedAt:$checked_at}')"
timestamp="$(date -u +%s)"
request_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
signature="$(
  PROBE_BODY="$body" PROBE_REQUEST_ID="$request_id" PROBE_TIMESTAMP="$timestamp" python3 -c \
    'import hashlib, hmac, os; message = "{}.{}.{}".format(os.environ["PROBE_TIMESTAMP"], os.environ["PROBE_REQUEST_ID"], os.environ["PROBE_BODY"]); print(hmac.new(os.environ["SUPPORT_RESTORE_PROBE_SECRET"].encode(), message.encode(), hashlib.sha256).hexdigest())'
)"

curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
  --request POST \
  --header 'content-type: application/json' \
  --header "x-support-timestamp: $timestamp" \
  --header "x-support-request-id: $request_id" \
  --header "x-support-signature: $signature" \
  --data-binary "$body" \
  "$endpoint" >/dev/null

if [[ $probe_exit -ne 0 ]]; then
  printf 'Off-host recovery proof failed and the failure receipt was reported.\n' >&2
  exit "$probe_exit"
fi
printf 'Off-host recovery proof passed and the signed receipt was reported.\n'
