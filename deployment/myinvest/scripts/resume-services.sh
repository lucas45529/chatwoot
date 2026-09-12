#!/usr/bin/env bash

# Source after defining the compose array. Resume containers individually:
# Compose can abort a dependency traversal when a parent is already unpaused.
resume_compose_services() {
  local service container_ids container_id state attempt resumed failed=0
  for service in "$@"; do
    # The caller supplies its existing Compose invocation, including the env file.
    # shellcheck disable=SC2154
    if ! container_ids="$("${compose[@]}" ps -a -q "$service")" || [[ -z "$container_ids" ]]; then
      printf 'Service %s: cannot locate containers to resume.\n' "$service" >&2
      failed=1
      continue
    fi
    while IFS= read -r container_id; do
      resumed=false
      for attempt in 1 2 3; do
        state="$(docker inspect --format '{{.State.Running}} {{.State.Paused}}' "$container_id" 2>/dev/null)" || state=unknown
        if [[ "$state" == 'true true' ]]; then
          docker unpause "$container_id" >/dev/null 2>&1 || true
          state="$(docker inspect --format '{{.State.Running}} {{.State.Paused}}' "$container_id" 2>/dev/null)" || state=unknown
        fi
        if [[ "$state" == 'true false' ]]; then
          resumed=true
          break
        fi
        if (( attempt < 3 )); then sleep 1; fi
      done
      if [[ "$resumed" != true ]]; then
        printf 'Service %s: could not resume container %s (state: %s).\n' "$service" "$container_id" "$state" >&2
        failed=1
      fi
    done <<< "$container_ids"
  done
  return "$failed"
}
