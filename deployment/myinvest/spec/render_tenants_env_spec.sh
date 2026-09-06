#!/usr/bin/env bash
set -Eeuo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime="$(mktemp -d)"
trap 'find "$runtime" -depth -delete' EXIT

install -m 0600 /dev/null "$runtime/tenants.json"
printf '%s\n' \
  '[{"key":"saas","accountId":7,"inboxId":11,"webhookSecret":"saas-webhook-secret-with-32-bytes","agentBotToken":"saas-agent-bot-token-with-32-bytes","handoffAssigneeId":1},{"key":"new_academy","accountId":8,"inboxId":12,"webhookSecret":"new-webhook-secret-with-32-bytes","agentBotToken":"new-agent-bot-token-with-32-bytes","handoffAssigneeId":1},{"key":"legacy_academy","accountId":9,"inboxId":13,"webhookSecret":"legacy-webhook-secret-with-32-bytes","agentBotToken":"legacy-agent-bot-token-with-32-bytes","handoffAssigneeId":1}]' \
  > "$runtime/tenants.json"
install -m 0600 /dev/null "$runtime/env"
printf '%s\n' 'TENANTS_JSON=[]' 'INTERN_SSO_RETURN_PATH=/app/accounts/1/inbox/1' 'AUTO_SEND_ENABLED=false' > "$runtime/env"

"$deployment_dir/scripts/render-tenants-env.rb" "$runtime/tenants.json" "$runtime/env" >/dev/null

grep -Fxq 'INTERN_SSO_RETURN_PATH=/app/accounts/7/dashboard?support_history=1' "$runtime/env"
grep -Fq '"inboxId":11' "$runtime/env"
permissions="$(stat -f '%Lp' "$runtime/env" 2>/dev/null || stat -c '%a' "$runtime/env")"
[[ "$permissions" == 600 ]]

ruby -rjson -e 'path = ARGV.fetch(0); tenants = JSON.parse(File.read(path)); tenants.each_with_index { |tenant, i| tenant["agentBotId"] = 20 + i }; File.write(path, JSON.generate(tenants))' "$runtime/tenants.json"
"$deployment_dir/scripts/render-tenants-env.rb" "$runtime/tenants.json" "$runtime/env" >/dev/null
grep -Fq '"agentBotId":20' "$runtime/env"
grep -Fxq 'AUTO_SEND_ENABLED=false' "$runtime/env"

ruby -rjson -e 'path = ARGV.fetch(0); tenants = JSON.parse(File.read(path)); tenants.first["agentBotId"] = nil; File.write(path, JSON.generate(tenants))' "$runtime/tenants.json"
if "$deployment_dir/scripts/render-tenants-env.rb" "$runtime/tenants.json" "$runtime/env" >/dev/null 2>&1; then
  printf 'Invalid bot identity was accepted.\n' >&2
  exit 1
fi
grep -Fq '"agentBotId":20' "$runtime/env"

printf 'Tenant renderer pins Intern SSO to the complete support history view.\n'
