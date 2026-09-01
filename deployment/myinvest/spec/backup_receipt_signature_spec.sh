#!/usr/bin/env bash
set -Eeuo pipefail

spec_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
verify_script="$spec_dir/../scripts/verify-backup-receipt.sh"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
export GNUPGHOME="$work_dir/gnupg"
mkdir -m 700 "$GNUPGHOME"

gpg --batch --passphrase '' --quick-generate-key \
  'MyInvest Backup Origin Test <backup-origin-test@myinvest.internal>' ed25519 sign 0 >/dev/null 2>&1
fingerprint="$(gpg --batch --with-colons --list-secret-keys | awk -F: '$1 == "fpr" { print $10; exit }')"
receipt="$work_dir/snapshot.offsite-receipt.json"
printf '{"snapshot":"20260831T120000Z","remote":"test:snapshot.tar.gpg","sha256":"%064d","encryption":"OpenPGP-AEAD-OCB-AES256","signer_fingerprint":"%s","created_at":"2026-08-31T12:00:00Z"}\n' 0 "$fingerprint" > "$receipt"
gpg --batch --yes --local-user "$fingerprint" --output "$receipt.asc" --armor --detach-sign "$receipt"

BACKUP_GPG_SIGNER_FINGERPRINT="$fingerprint" "$verify_script" "$receipt"

printf '\n' >> "$receipt"
if BACKUP_GPG_SIGNER_FINGERPRINT="$fingerprint" "$verify_script" "$receipt" >/dev/null 2>&1; then
  printf 'Tampered receipt unexpectedly passed origin verification.\n' >&2
  exit 1
fi

printf 'Backup receipt origin signature regression passed.\n'
