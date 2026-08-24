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

runtime_path="$deployment_dir/runtime/tenants.json"
export SUPPORT_HANDOFF_ASSIGNEES_JSON="$(
  jq -ce '
    if ((map(.key) | sort) == ["legacy_academy", "new_academy", "saas"]) and
       all(.[];
         (.accountId | type == "number" and . > 0) and
         (.handoffAssigneeId | type == "number" and . > 0)
       )
    then map({ key, accountId, handoffAssigneeId })
    else error("tenant handoff assignees are incomplete")
    end
  ' "$runtime_path"
)"

command=(
  docker compose
  --project-directory "$deployment_dir"
  --env-file "$env_path"
  -f "$deployment_dir/compose.yaml"
  run --rm
  -e SUPPORT_EXPERIENCE_RUN=true
  -e "SUPPORT_EXPERIENCE_MODE=$runner_mode"
  -e SUPPORT_HANDOFF_ASSIGNEES_JSON
  rails bundle exec rails runner /bootstrap/support_experience.rb
)

if ! "${command[@]}"; then
  printf '{"command":"support-experience","mode":"%s","status":"failed"}\n' "$runner_mode" >&2
  exit 1
fi
