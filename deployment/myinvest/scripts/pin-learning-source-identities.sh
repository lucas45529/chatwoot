#!/usr/bin/env bash
set -Eeuo pipefail

# Metadata-only rollout. No seed, database mutation, bot attachment, service
# restart or auto-send change. Recreate the agent separately when authorized.
deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_path="${ENV_FILE:-$deployment_dir/.env}"
env_dir="$(cd "$(dirname "$env_path")" && pwd)"
env_name="$(basename "$env_path")"
compose=(docker compose --project-directory "$deployment_dir" --env-file "$env_path" -f "$deployment_dir/compose.yaml")

"${compose[@]}" run --rm --no-deps -e PIN_LEARNING_SOURCE_IDENTITY_RUN=true \
  rails bundle exec rails runner /bootstrap/learning_source_identity.rb
"${compose[@]}" run --rm --no-deps \
  -e RENDER_ENV_NAME="$env_name" -e HOST_DEPLOY_UID="$(id -u)" -e HOST_DEPLOY_GID="$(id -g)" \
  -v "$deployment_dir/scripts:/bootstrap-scripts:ro" -v "$env_dir:/bootstrap-env" \
  --entrypoint sh rails -ec '
    ruby /bootstrap-scripts/pin-learning-source-metadata.rb /bootstrap-output/tenants.json "/bootstrap-env/$RENDER_ENV_NAME" /bootstrap-output/learning-source-identities.json
    chown "$HOST_DEPLOY_UID:$HOST_DEPLOY_GID" "/bootstrap-env/$RENDER_ENV_NAME" /bootstrap-output/tenants.json
  '
printf 'Learning source metadata prepared; running services and delivery switches are unchanged.\n'
