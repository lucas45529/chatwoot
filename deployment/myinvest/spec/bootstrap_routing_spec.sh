#!/usr/bin/env bash
set -Eeuo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
seed="$deployment_dir/bootstrap/seed.rb"
smoke="$deployment_dir/scripts/smoke.sh"
renderer="$deployment_dir/scripts/render-tenants-env.rb"

grep -Fq 'inbox.update!(enable_auto_assignment: false)' "$seed"
grep -Fq 'routing_valid = !inbox.enable_auto_assignment? && inbox.agent_bot_inbox&.active?' "$smoke"
grep -Fq 'abort("Invalid AgentBot routing for #{inbox.name}") unless routing_valid' "$smoke"
grep -Fq "raise 'Intern SSO user must not be a SuperAdmin'" "$seed"
grep -Fq 'AccountUser.where(user: intern_sso_user).where.not(account: account).destroy_all' "$seed"
grep -Fq 'InboxMember.find_or_create_by!(inbox: inbox, user: intern_sso_user)' "$seed"
grep -Fq 'inboxId: inbox.id' "$seed"
grep -Fq 'INTERN_SSO_RETURN_PATH=/app/accounts/#{support.fetch('\''accountId'\'')}/inbox/#{support.fetch('\''inboxId'\'')}' "$renderer"
grep -Fq 'Intern SSO user must belong to exactly one account' "$smoke"
grep -Fq 'tenant_configuration_pending=true' "$deployment_dir/scripts/validate.sh"

printf 'Bootstrap routing contract passed: live inboxes stay assigned to active AgentBots.\n'
