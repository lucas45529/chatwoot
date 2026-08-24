#!/usr/bin/env bash
set -Eeuo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_path="${ENV_FILE:-$deployment_dir/.env}"
mode="${1:-dry-run}"

if (( $# > 1 )) || [[ "$mode" != "dry-run" && "$mode" != "--apply" ]]; then
  printf 'Usage: apply-support-experience.sh [--apply]\n' >&2
  exit 1
fi

runner_mode=dry-run
[[ "$mode" == "--apply" ]] && runner_mode=apply

command=(
  docker compose
  --project-directory "$deployment_dir"
  --env-file "$env_path"
  -f "$deployment_dir/compose.yaml"
  run --rm
  -e SUPPORT_EXPERIENCE_RUN=true
  -e "SUPPORT_EXPERIENCE_MODE=$runner_mode"
  rails bundle exec rails runner /bootstrap/support_experience.rb
)

if ! "${command[@]}"; then
  printf '{"command":"support-experience","mode":"%s","status":"failed"}\n' "$runner_mode" >&2
  exit 1
fi
