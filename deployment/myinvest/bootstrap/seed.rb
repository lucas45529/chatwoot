# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'securerandom'
require_relative 'rebooking_bridge'

required = %w[
  ADMIN_NAME ADMIN_EMAIL INTERN_SSO_EMAIL INTERN_SSO_PASSWORD MYINVEST_ACCOUNT_NAME
  ACADEMY_NEW_ACCOUNT_NAME ACADEMY_LEGACY_ACCOUNT_NAME
  MYINVEST_WEBSITE_URL ACADEMY_NEW_WEBSITE_URL ACADEMY_LEGACY_WEBSITE_URL
  MYINVEST_REBOOKING_WEBHOOK_URL
]
missing = required.select { |key| ENV[key].blank? }
raise "Missing bootstrap variables: #{missing.join(', ')}" if missing.any?

account_names = [
  ['saas', ENV.fetch('MYINVEST_ACCOUNT_NAME'), ENV.fetch('MYINVEST_WEBSITE_URL')],
  ['new_academy', ENV.fetch('ACADEMY_NEW_ACCOUNT_NAME'), ENV.fetch('ACADEMY_NEW_WEBSITE_URL')],
  ['legacy_academy', ENV.fetch('ACADEMY_LEGACY_ACCOUNT_NAME'), ENV.fetch('ACADEMY_LEGACY_WEBSITE_URL')]
]
canonical_keys = account_names.map(&:first)
configured_names = account_names.map { |_, name, _| name }
raise 'MyInvest tenant account names must be distinct' unless configured_names.uniq.length == account_names.length

agent_bot_name = 'MyInvest Support'
legacy_agent_bot_name = 'MyInvest Claude Support'

tenant_credentials = []
rebooking_bridge_credentials = nil
# rubocop:disable Metrics/BlockLength
ActiveRecord::Base.transaction do
  ActiveRecord::Base.connection.execute('SELECT pg_advisory_xact_lock(728395104)')

  tagged_accounts = Account.where("custom_attributes ? 'myinvest_tenant_key'").to_a
  unknown_keys = tagged_accounts.filter_map do |account|
    tenant_key = account.custom_attributes['myinvest_tenant_key']
    tenant_key.to_s.presence || '(blank)' unless canonical_keys.include?(tenant_key)
  end.uniq.sort
  raise "Unknown MyInvest tenant keys: #{unknown_keys.join(', ')}" if unknown_keys.any?

  accounts_by_key = tagged_accounts.group_by { |account| account.custom_attributes['myinvest_tenant_key'] }
  duplicate_key = canonical_keys.find { |key| accounts_by_key.fetch(key, []).length > 1 }
  raise "Duplicate MyInvest tenant account for key: #{duplicate_key}" if duplicate_key

  account_names.each do |key, name, _|
    canonical_account = accounts_by_key.fetch(key, []).first
    conflicting_name = Account.where(name: name).where.not(id: canonical_account&.id).exists?
    next unless conflicting_name

    raise "MyInvest tenant account name is already used without its canonical key: #{name}"
  end

  admin = User.from_email(ENV.fetch('ADMIN_EMAIL'))
  unless admin
    raise 'ADMIN_PASSWORD is required when creating the initial administrator' if ENV['ADMIN_PASSWORD'].blank?

    admin = User.new(
      name: ENV.fetch('ADMIN_NAME'),
      email: ENV.fetch('ADMIN_EMAIL'),
      password: ENV.fetch('ADMIN_PASSWORD'),
      password_confirmation: ENV.fetch('ADMIN_PASSWORD'),
      type: 'SuperAdmin'
    )
    admin.skip_confirmation!
    admin.save!
  end
  intern_sso_user = User.from_email(ENV.fetch('INTERN_SSO_EMAIL')) || User.new
  intern_sso_user.name = ENV.fetch('ADMIN_NAME')
  intern_sso_user.email = ENV.fetch('INTERN_SSO_EMAIL')
  intern_sso_user.password = ENV.fetch('INTERN_SSO_PASSWORD')
  intern_sso_user.password_confirmation = ENV.fetch('INTERN_SSO_PASSWORD')
  intern_sso_user.skip_confirmation!
  intern_sso_user.save!
  raise 'Intern SSO user must not be a SuperAdmin' if intern_sso_user.is_a?(SuperAdmin)

  integration_user = User.from_email('support-bridge@myinvest.internal')
  unless integration_user
    password = SecureRandom.urlsafe_base64(48)
    integration_user = User.new(
      name: 'MyInvest Support Bridge',
      email: 'support-bridge@myinvest.internal',
      password: password,
      password_confirmation: password
    )
    integration_user.skip_confirmation!
    integration_user.save!
  end
  raise 'Rebooking integration user must not be a SuperAdmin' if integration_user.is_a?(SuperAdmin)


  account_names.each do |key, name, website_url|
    account = accounts_by_key.fetch(key, []).first || Account.new
    account.name = name
    account.locale = :de
    account.custom_attributes = account.custom_attributes.merge(
      'managed_by' => 'myinvest-bootstrap',
      'myinvest_tenant_key' => key
    )
    account.save!
    AccountUser.find_or_create_by!(account: account, user: admin) do |membership|
      membership.role = :administrator
    end
    if key == 'saas'
      AccountUser.where(user: intern_sso_user).where.not(account: account).destroy_all
      sso_membership = AccountUser.find_or_initialize_by(account: account, user: intern_sso_user)
      sso_membership.role = :administrator
      sso_membership.save!
    end

    managed_bots = AgentBot.where(
      account: account,
      name: [agent_bot_name, legacy_agent_bot_name]
    ).to_a
    raise "Duplicate managed AgentBots for tenant: #{key}" if managed_bots.length > 1

    agent_bot = managed_bots.first || AgentBot.new(account: account)
    agent_bot.name = agent_bot_name
    agent_bot.description = "Tenant-scoped MyInvest support assistant for #{name}"
    agent_bot.outgoing_url = "#{ENV.fetch('FRONTEND_URL').delete_suffix('/')}/_agent/webhooks/chatwoot"
    agent_bot.save!

    inbox_name = "#{name} Website"
    inbox = Inbox.find_by(account: account, name: inbox_name)
    unless inbox
      channel = Channel::Api.create!(
        account: account,
        webhook_url: nil,
        hmac_mandatory: false,
        additional_attributes: {
          'managed_by' => 'myinvest-bootstrap',
          'myinvest_support_bridge' => true,
          'myinvest_website_url' => website_url
        }
      )
      inbox = Inbox.create!(account: account, channel: channel, name: inbox_name)
    end
    unless inbox.channel.is_a?(Channel::Api)
      previous_channel = inbox.channel
      channel = Channel::Api.create!(
        account: account,
        webhook_url: nil,
        hmac_mandatory: false,
        additional_attributes: {
          'managed_by' => 'myinvest-bootstrap',
          'myinvest_support_bridge' => true,
          'myinvest_website_url' => website_url,
          'myinvest_replaced_channel_type' => previous_channel.class.name,
          'myinvest_replaced_channel_id' => previous_channel.id
        }
      )
      inbox.update!(channel: channel)
    end
    raise "Managed inbox is not an API inbox: #{inbox_name}" unless inbox.channel.is_a?(Channel::Api)
    inbox.channel.update!(
      webhook_url: nil,
      hmac_mandatory: false,
      additional_attributes: inbox.channel.additional_attributes.merge(
        'managed_by' => 'myinvest-bootstrap',
        'myinvest_support_bridge' => true,
        'myinvest_website_url' => website_url
      )
    )
    inbox.update!(enable_auto_assignment: false)

    InboxMember.find_or_create_by!(inbox: inbox, user: admin)
    if key == 'saas'
      InboxMember.joins(:inbox)
        .where(user: intern_sso_user)
        .where.not(inboxes: { account_id: account.id })
        .destroy_all
      InboxMember.find_or_create_by!(inbox: inbox, user: intern_sso_user)
    end
    bot_inbox = AgentBotInbox.find_or_initialize_by(inbox: inbox)
    bot_inbox.agent_bot = agent_bot
    bot_inbox.status = :active
    bot_inbox.save!
    if key == 'new_academy'
      AccountUser.where(user: integration_user).where.not(account: account).destroy_all
      integration_membership = AccountUser.find_or_initialize_by(account: account, user: integration_user)
      integration_membership.role = :administrator
      integration_membership.save!
    end
    if key == 'new_academy'
      rebooking_bridge_credentials = Myinvest::RebookingBridge.new(
        account: account,
        administrator: admin,
        integration_user: integration_user,
        agent_bot: agent_bot,
        webhook_url: ENV.fetch('MYINVEST_REBOOKING_WEBHOOK_URL')
      ).call.merge(account_id: account.id)
    end

    tenant_credentials << {
      key: key,
      accountId: account.id,
      inboxId: inbox.id,
      webhookSecret: agent_bot.secret,
      handoffAssigneeId: key == 'saas' ? intern_sso_user.id : admin.id,
      agentBotToken: agent_bot.access_token.token
    }
  end
end
# rubocop:enable Metrics/BlockLength

output_directory = '/bootstrap-output'
FileUtils.mkdir_p(output_directory, mode: 0o700)
temporary_path = File.join(output_directory, "tenants.json.tmp.#{Process.pid}")
output_path = File.join(output_directory, 'tenants.json')
File.write(temporary_path, JSON.generate(tenant_credentials), mode: 'w', perm: 0o600)
File.rename(temporary_path, output_path)
File.chmod(0o600, output_path)

raise 'Rebooking bridge credentials were not provisioned' unless rebooking_bridge_credentials

bridge_temporary_path = File.join(output_directory, "rebooking-bridge.json.tmp.#{Process.pid}")
bridge_output_path = File.join(output_directory, 'rebooking-bridge.json')
File.write(bridge_temporary_path, JSON.generate(rebooking_bridge_credentials), mode: 'w', perm: 0o600)
File.rename(bridge_temporary_path, bridge_output_path)
File.chmod(0o600, bridge_output_path)

puts "Bootstrap complete: #{account_names.length} account boundaries, API support inboxes, rebooking bridge, and Agent Bots."
