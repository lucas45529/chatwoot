#!/usr/bin/env bash
set -Eeuo pipefail

receipt_path="${1:-}"
signature_path="${receipt_path}.asc"
[[ -n "$receipt_path" && -f "$receipt_path" && -f "$signature_path" ]] || {
  printf 'Usage: BACKUP_GPG_SIGNER_FINGERPRINT=... %s <offsite-receipt.json>\n' "$0" >&2
  exit 1
}
[[ "${BACKUP_GPG_SIGNER_FINGERPRINT:-}" =~ ^[0-9A-Fa-f]{40,64}$ ]] || {
  printf 'BACKUP_GPG_SIGNER_FINGERPRINT must be a full signing-key fingerprint.\n' >&2
  exit 1
}
command -v gpg >/dev/null 2>&1 || {
  printf 'gpg is required for receipt verification.\n' >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  printf 'jq is required for receipt verification.\n' >&2
  exit 1
}

status="$({ gpg --batch --status-fd 1 --verify "$signature_path" "$receipt_path" 2>/dev/null; } || true)"
verified_fingerprint="$(printf '%s\n' "$status" | awk '$1 == "[GNUPG:]" && $2 == "VALIDSIG" { print $3; exit }')"
expected_fingerprint="$(printf '%s' "$BACKUP_GPG_SIGNER_FINGERPRINT" | tr '[:lower:]' '[:upper:]')"
verified_fingerprint="$(printf '%s' "$verified_fingerprint" | tr '[:lower:]' '[:upper:]')"
[[ "$verified_fingerprint" == "$expected_fingerprint" ]] || {
  printf 'Backup receipt signature does not match the pinned origin key.\n' >&2
  exit 1
}
receipt_fingerprint="$(jq -er '.signer_fingerprint | select(type == "string" and test("^[0-9A-Fa-f]{40,64}$"))' "$receipt_path")"
receipt_fingerprint="$(printf '%s' "$receipt_fingerprint" | tr '[:lower:]' '[:upper:]')"
[[ "$receipt_fingerprint" == "$expected_fingerprint" ]] || {
  printf 'Backup receipt signer metadata does not match the pinned origin key.\n' >&2
  exit 1
}
