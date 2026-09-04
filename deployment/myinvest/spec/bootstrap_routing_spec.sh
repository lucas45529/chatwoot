#!/usr/bin/env bash
set -Eeuo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
seed="$deployment_dir/bootstrap/seed.rb"
smoke="$deployment_dir/scripts/smoke.sh"
renderer="$deployment_dir/scripts/render-tenants-env.rb"
production_e2e="$deployment_dir/scripts/e2e-production.sh"
production_e2e_context="$deployment_dir/bootstrap/e2e_production_path.rb"

grep -Fq 'inbox.update!(enable_auto_assignment: false)' "$seed"
grep -Fq 'Channel::Api.create!(' "$seed"
grep -Fq 'inbox.update!(channel: channel)' "$seed"
grep -Fq 'Managed inbox is not an API inbox' "$seed"
! grep -Fq 'Channel::WebWidget.create!' "$seed"
! grep -Fq 'websiteToken:' "$seed"
grep -Fq 'api_token: intern_sso_user.access_token.token' "$production_e2e_context"
grep -Fq -- '-e FRONTEND_URL -e LOCAL_SMOKE -e INTERN_SSO_EMAIL' "$production_e2e"
grep -Fq 'api_access_token: $api_token' "$production_e2e"
grep -Fq 'content_attributes:{myinvest_agent_action:"draft"}' "$production_e2e"
grep -Fq '/api/v1/accounts/$account_id' "$production_e2e"
! grep -Fq '/api/v1/widget' "$production_e2e"
grep -Fq 'routing_valid = !inbox.enable_auto_assignment? && inbox.agent_bot_inbox&.active?' "$smoke"
grep -Fq 'abort("Invalid AgentBot routing for #{inbox.name}") unless routing_valid' "$smoke"
grep -Fq "raise 'Intern SSO user must not be a SuperAdmin'" "$seed"
grep -Fq 'AccountUser.where(user: intern_sso_user).where.not(account: account).destroy_all' "$seed"
grep -Fq 'InboxMember.find_or_create_by!(inbox: inbox, user: intern_sso_user)' "$seed"
grep -Fq 'inboxId: inbox.id' "$seed"
grep -Fq 'INTERN_SSO_RETURN_PATH=/app/accounts/#{support.fetch('\''accountId'\'')}/inbox/#{support.fetch('\''inboxId'\'')}' "$renderer"
grep -Fq 'Intern SSO user must belong to exactly one account' "$smoke"
grep -Fq 'tenant_configuration_pending=true' "$deployment_dir/scripts/validate.sh"
grep -Fq 'ruby /bootstrap-scripts/render-tenants-env.rb /bootstrap-output/tenants.json' "$deployment_dir/scripts/bootstrap.sh"
grep -Fq 'chown "$HOST_DEPLOY_UID:$HOST_DEPLOY_GID"' "$deployment_dir/scripts/bootstrap.sh"
[[ "$(grep -Fc 'source "$env_path"' "$deployment_dir/scripts/bootstrap.sh")" -eq 2 ]]
grep -Fq 'build claude-agent' "$deployment_dir/scripts/bootstrap.sh"
grep -Fq 'up -d --no-deps --no-build --force-recreate claude-agent' "$deployment_dir/scripts/bootstrap.sh"

printf 'Bootstrap routing contract passed: live inboxes stay assigned to active AgentBots.\n'
