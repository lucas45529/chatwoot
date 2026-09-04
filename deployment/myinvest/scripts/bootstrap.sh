#!/usr/bin/env bash
set -Eeuo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_path="${ENV_FILE:-$deployment_dir/.env}"
env_dir="$(cd "$(dirname "$env_path")" && pwd)"
env_name="$(basename "$env_path")"
if [[ -z "${CHATWOOT_BUILD_GIT_SHA:-}" ]]; then
  CHATWOOT_BUILD_GIT_SHA="$("$deployment_dir/scripts/resolve-build-revision.sh")"
  export CHATWOOT_BUILD_GIT_SHA
fi
compose=(docker compose --project-directory "$deployment_dir" --env-file "$env_path" -f "$deployment_dir/compose.yaml")

ALLOW_UNBOOTSTRAPPED_TENANTS=true "$deployment_dir/scripts/validate.sh"
set -a
# shellcheck disable=SC1090
source "$env_path"
set +a
bootstrap_environment=(
  -e ADMIN_NAME -e ADMIN_EMAIL -e ADMIN_PASSWORD
  -e INTERN_SSO_EMAIL -e INTERN_SSO_PASSWORD
  -e MYINVEST_ACCOUNT_NAME -e ACADEMY_NEW_ACCOUNT_NAME -e ACADEMY_LEGACY_ACCOUNT_NAME
  -e MYINVEST_WEBSITE_URL -e ACADEMY_NEW_WEBSITE_URL -e ACADEMY_LEGACY_WEBSITE_URL
  -e MYINVEST_REBOOKING_WEBHOOK_URL
)
"${compose[@]}" run --rm rails bundle exec rails runner /bootstrap/branding.rb
"${compose[@]}" run --rm "${bootstrap_environment[@]}" rails bundle exec rails runner /bootstrap/seed.rb
"${compose[@]}" run --rm --no-deps \
  -e RENDER_ENV_NAME="$env_name" -e HOST_DEPLOY_UID="$(id -u)" -e HOST_DEPLOY_GID="$(id -g)" \
  -v "$deployment_dir/scripts:/bootstrap-scripts:ro" -v "$env_dir:/bootstrap-env" \
  --entrypoint sh rails -ec '
    ruby /bootstrap-scripts/render-tenants-env.rb /bootstrap-output/tenants.json "/bootstrap-env/$RENDER_ENV_NAME"
    chown "$HOST_DEPLOY_UID:$HOST_DEPLOY_GID" "/bootstrap-env/$RENDER_ENV_NAME" \
      /bootstrap-output/tenants.json /bootstrap-output/rebooking-bridge.json
  '
"${compose[@]}" up -d --build --force-recreate claude-agent
printf 'Three account boundaries, website inboxes, scoped Agent Bots, and the Claude agent are present.\n'
