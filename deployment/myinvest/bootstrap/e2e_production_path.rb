# frozen_string_literal: true

require 'fileutils'
require 'json'

raise 'Production E2E refuses LOCAL_SMOKE=true' if ENV.fetch('LOCAL_SMOKE', 'false') == 'true'

account = Account.where("custom_attributes ->> 'myinvest_tenant_key' = ?", 'saas').first!
inbox = account.inboxes.find_by!(name: "#{account.name} Website")
raise 'Managed support inbox is not an API inbox' unless inbox.channel.is_a?(Channel::Api)
agent_bot = inbox.agent_bot
raise 'Managed AgentBot is missing' unless agent_bot
intern_sso_user = User.from_email(ENV.fetch('INTERN_SSO_EMAIL'))
raise 'Intern SSO user is missing' unless intern_sso_user
raise 'Intern SSO user is not assigned to the support inbox' unless inbox.members.exists?(id: intern_sso_user.id)

expected_url = "#{ENV.fetch('FRONTEND_URL').delete_suffix('/')}/_agent/webhooks/chatwoot"
raise 'Managed AgentBot URL is not the production endpoint' unless agent_bot.outgoing_url == expected_url

context = {
  account_id: account.id,
  inbox_id: inbox.id,
  api_token: intern_sso_user.access_token.token
}
path = '/bootstrap-output/e2e-production.json'
File.write(path, JSON.generate(context), mode: 'w', perm: 0o600)
File.chmod(0o600, path)
