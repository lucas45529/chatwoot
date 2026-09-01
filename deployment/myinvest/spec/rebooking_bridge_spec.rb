require 'rails_helper'
require Rails.root.join('deployment/myinvest/bootstrap/rebooking_bridge')

# rubocop:disable RSpec/SpecFilePathFormat
RSpec.describe Myinvest::RebookingBridge do
  subject(:provisioner) do
    described_class.new(
      account: account,
      administrator: administrator,
      integration_user: integration_user,
      agent_bot: agent_bot,
      webhook_url: 'https://myinvest-pro.com/api/webhooks/chatwoot'
    )
  end

  let(:account) { create(:account, custom_attributes: { 'myinvest_tenant_key' => 'new_academy' }) }
  let(:administrator) { create(:user) }
  let(:integration_user) { create(:user) }
  let(:agent_bot) { create(:agent_bot, account: account) }
  let!(:account_user) do
    create(:account_user, account: account, user: administrator, role: :administrator)
  end
  let!(:integration_account_user) do
    create(:account_user, account: account, user: integration_user, role: :administrator)
  end

  # rubocop:disable RSpec/MultipleExpectations
  it 'idempotently provisions the unified support API inbox and visible appointment fields' do
    first = provisioner.call
    second = provisioner.call

    inbox = account.inboxes.find_by!(name: described_class::INBOX_NAME)
    expect(account.inboxes.where(name: described_class::INBOX_NAME).count).to eq(1)
    expect(inbox.channel).to be_a(Channel::Api)
    expect(inbox.channel.webhook_url).to eq('https://myinvest-pro.com/api/webhooks/chatwoot')
    expect(inbox.channel.hmac_mandatory).to be(true)
    expect(inbox.channel.secret).to eq(first.fetch(:webhook_secret))
    expect(second).to eq(first)
    expect(first).not_to have_key(:inbox_identifier)
    expect(AccessToken.find_by!(token: first.fetch(:api_token)).owner).to eq(integration_user)
    expect(inbox.members).to include(administrator)
    expect(AgentBotInbox.find_by!(inbox: inbox)).to have_attributes(agent_bot: agent_bot, status: 'active')

    definitions = account.custom_attribute_definitions.conversation_attribute.index_by(&:attribute_key)
    expect(definitions.keys).to include(*described_class::CUSTOM_ATTRIBUTES.pluck(:key))
    expect(account.labels.pluck(:title)).to include(*described_class::LABELS.pluck(:title))
    expect(definitions.fetch('myinvest_appointment_owner')).to have_attributes(
      attribute_display_name: 'Termininhaber',
      attribute_display_type: 'text'
    )
    expect(definitions.fetch('myinvest_appointment_at')).to have_attributes(
      attribute_display_name: 'Terminbeginn',
      attribute_display_type: 'text'
    )
  end
  # rubocop:enable RSpec/MultipleExpectations

  it 'renames the legacy WhatsApp inbox instead of creating a second team inbox' do
    channel = Channel::Api.create!(account: account, webhook_url: 'https://legacy.example.test/webhook')
    legacy = Inbox.create!(
      account: account,
      channel: channel,
      name: described_class::LEGACY_INBOX_NAMES.first
    )

    credentials = provisioner.call

    expect(legacy.reload.name).to eq(described_class::INBOX_NAME)
    expect(legacy.channel.reload.hmac_mandatory).to be(true)
    expect(account.inboxes.where(id: legacy.id)).to exist
    expect(account.inboxes.where(name: described_class::INBOX_NAME).count).to eq(1)
    expect(credentials.fetch(:inbox_id)).to eq(legacy.id)
  end

  it 'refuses an integration user with cross-tenant access' do
    create(:account_user, account: create(:account), user: integration_user, role: :administrator)

    expect { provisioner.call }.to raise_error(
      described_class::ConfigurationError,
      /only to the rebooking account/
    )
  end

  it 'refuses to repurpose an inbox with an incompatible channel' do
    create(:inbox, account: account, name: described_class::INBOX_NAME)

    expect { provisioner.call }.to raise_error(described_class::ConfigurationError, /API inbox/)
  end
end
# rubocop:enable RSpec/SpecFilePathFormat
