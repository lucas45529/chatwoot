#!/usr/bin/env bash
set -Eeuo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_path="${ENV_FILE:-$deployment_dir/.env}"
snapshot="${1:-}"

[[ -n "$snapshot" && -d "$snapshot" ]] || {
  printf 'Usage: %s <completed-snapshot-directory>\n' "$0" >&2
  exit 1
}
snapshot="$(cd "$snapshot" && pwd)"
snapshot_name="$(basename "$snapshot")"
[[ -f "$snapshot/SHA256SUMS" ]] || {
  printf 'Snapshot has no SHA256SUMS: %s\n' "$snapshot" >&2
  exit 1
}
(cd "$snapshot" && shasum -a 256 -c SHA256SUMS >/dev/null)

set -a
# shellcheck disable=SC1090
source "$env_path"
set +a

[[ -n "${BACKUP_GPG_RECIPIENT:-}" ]] || {
  printf 'BACKUP_GPG_RECIPIENT is required.\n' >&2
  exit 1
}
[[ -n "${BACKUP_GPG_SIGNING_KEY:-}" ]] || {
  printf 'BACKUP_GPG_SIGNING_KEY is required.\n' >&2
  exit 1
}
[[ -n "${BACKUP_OFFSITE_REMOTE:-}" ]] || {
  printf 'BACKUP_OFFSITE_REMOTE is required.\n' >&2
  exit 1
}
for command_name in gpg jq rclone shasum tar; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf '%s is required for off-host backup.\n' "$command_name" >&2
    exit 1
  }
done
gpg --dump-options | grep -qx -- '--force-aead' || {
  printf 'GnuPG with authenticated-encryption support is required.\n' >&2
  exit 1
}

archive_name="${snapshot_name}.tar.gpg"
remote_root="${BACKUP_OFFSITE_REMOTE%/}"
remote_path="$remote_root/$archive_name"
remote_receipt_path="$remote_root/${snapshot_name}.offsite-receipt.json"
remote_signature_path="${remote_receipt_path}.asc"
encrypted_archive="$(mktemp "${snapshot}.offsite.XXXXXX.tar.gpg")"
retained_archive="${snapshot}.tar.gpg"
receipt_path="${snapshot}.offsite-receipt.json"
signature_path="${receipt_path}.asc"
temporary_receipt="${receipt_path}.tmp.$$"
temporary_signature="${signature_path}.tmp.$$"
cleanup_artifacts() {
  rm -f -- "$encrypted_archive" "$temporary_receipt" "$temporary_signature"
}
trap cleanup_artifacts EXIT
chmod 600 "$encrypted_archive"

signer_fingerprint="$(
  gpg --batch --with-colons --list-secret-keys "$BACKUP_GPG_SIGNING_KEY" |
    awk -F: '$1 == "fpr" { print $10; exit }'
)"
[[ "$signer_fingerprint" =~ ^[0-9A-Fa-f]{40,64}$ ]] || {
  printf 'BACKUP_GPG_SIGNING_KEY did not resolve to a signing-key fingerprint.\n' >&2
  exit 1
}

tar -C "$(dirname "$snapshot")" -cf - "$snapshot_name" |
  gpg --batch --yes --trust-model always --force-aead --aead-algo OCB --cipher-algo AES256 \
    --recipient "$BACKUP_GPG_RECIPIENT" --output "$encrypted_archive" --encrypt
local_sha256="$(shasum -a 256 "$encrypted_archive" | awk '{print $1}')"

rclone copyto --immutable "$encrypted_archive" "$remote_path"
remote_sha256="$(rclone cat "$remote_path" | shasum -a 256 | awk '{print $1}')"
[[ "$remote_sha256" == "$local_sha256" ]] || {
  printf 'Off-host ciphertext checksum verification failed.\n' >&2
  exit 1
}
normalized_signer_fingerprint="$(printf '%s' "$signer_fingerprint" | tr '[:lower:]' '[:upper:]')"

jq -cn \
  --arg snapshot "$snapshot_name" --arg remote "$remote_path" --arg sha256 "$local_sha256" \
  --arg signer_fingerprint "$normalized_signer_fingerprint" \
  --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{snapshot:$snapshot,remote:$remote,sha256:$sha256,encryption:"OpenPGP-AEAD-OCB-AES256",signer_fingerprint:$signer_fingerprint,created_at:$created_at}' \
  > "$temporary_receipt"
chmod 600 "$temporary_receipt"
gpg --batch --yes --local-user "$BACKUP_GPG_SIGNING_KEY" \
  --output "$temporary_signature" --armor --detach-sign "$temporary_receipt"
chmod 600 "$temporary_signature"
rclone copyto --immutable "$temporary_receipt" "$remote_receipt_path"
rclone copyto --immutable "$temporary_signature" "$remote_signature_path"
mv "$temporary_receipt" "$receipt_path"
mv "$temporary_signature" "$signature_path"
mv "$encrypted_archive" "$retained_archive"
trap - EXIT
printf 'Signed authenticated snapshot uploaded and remotely checksum-verified: %s\n' "$remote_path"
