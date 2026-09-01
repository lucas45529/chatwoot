#!/usr/bin/env bash
set -Eeuo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repository_root="$(git -C "$deployment_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  printf 'Cannot resolve the Chatwoot repository root.\n' >&2
  exit 1
}
revision="$(git -C "$repository_root" rev-parse --verify HEAD)"
if [[ -n "$(git -C "$repository_root" status --porcelain=v1 --untracked-files=normal)" ]]; then
  revision="${revision}-dirty"
fi
printf '%s\n' "$revision"
