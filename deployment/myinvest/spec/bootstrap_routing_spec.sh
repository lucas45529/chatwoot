#!/usr/bin/env bash
set -Eeuo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
seed="$deployment_dir/bootstrap/seed.rb"
smoke="$deployment_dir/scripts/smoke.sh"

grep -Fq 'inbox.update!(enable_auto_assignment: false)' "$seed"
grep -Fq 'routing_valid = !inbox.enable_auto_assignment? && inbox.agent_bot_inbox&.active?' "$smoke"
grep -Fq 'abort("Invalid AgentBot routing for #{inbox.name}") unless routing_valid' "$smoke"

printf 'Bootstrap routing contract passed: live inboxes stay assigned to active AgentBots.\n'
