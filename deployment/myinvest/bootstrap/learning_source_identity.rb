# frozen_string_literal: true

require 'json'
require 'digest'

module Myinvest; end

# Read existing identities only. In particular, never run seed.rb to fill this
# metadata: seed attaches bots and configures outgoing webhooks.
class Myinvest::LearningSourceIdentity
  def initialize(tokens: AccessToken)
    @tokens = tokens
  end

  def call(tenants)
    unless tenants.is_a?(Array) && tenants.map { |entry| entry.fetch('key') }.sort == %w[legacy_academy new_academy saas]
      raise 'Expected the three canonical tenant identities'
    end
    tenants.map do |entry|
      token = @tokens.find_by!(owner_type: 'AgentBot', token: entry.fetch('agentBotToken'))
      bot = token.owner
      unless bot.account_id == entry.fetch('accountId') &&
             bot.account.custom_attributes.fetch('myinvest_tenant_key') == entry.fetch('key') &&
             (!entry.key?('agentBotId') || entry.fetch('agentBotId') == bot.id)
        raise 'Configured bot identity does not match its tenant'
      end
      entry.merge('agentBotId' => bot.id)
    end
  end
end

if ENV['PIN_LEARNING_SOURCE_IDENTITY_RUN'] == 'true'
  begin
    # This short-lived runner has no reason to log credential-bound SELECTs.
    ActiveRecord::Base.logger = nil
    path = '/bootstrap-output/tenants.json'
    original = File.read(path)
    tenants = ActiveRecord::Base.transaction(requires_new: true) do
      ActiveRecord::Base.connection.execute('SET TRANSACTION READ ONLY')
      Myinvest::LearningSourceIdentity.new.call(JSON.parse(original))
    end
    raise 'Runtime tenant configuration changed concurrently' unless File.read(path) == original

    # The separate metadata merger validates the live env before changing
    # either credential file. Only this non-secret identity map is emitted.
    output_path = '/bootstrap-output/learning-source-identities.json'
    metadata = {
      runtimeSha256: Digest::SHA256.hexdigest(original),
      identities: tenants.map { |entry| entry.slice('key', 'accountId', 'agentBotId') }
    }
    temporary_path = "#{output_path}.tmp.#{Process.pid}"
    File.open(temporary_path, File::WRONLY | File::CREAT | File::EXCL, 0o600) do |file|
      file.write(JSON.generate(metadata))
      file.write("\n")
    end
    File.rename(temporary_path, output_path)
    File.chmod(0o600, output_path)
    puts 'Resolved existing learning source identities; bot state is unchanged.'
  rescue StandardError
    # DB exceptions can embed token query parameters. Emit only a fixed code.
    warn 'Learning source identity pinning failed; no bot state was changed.'
    exit 1
  end
end
