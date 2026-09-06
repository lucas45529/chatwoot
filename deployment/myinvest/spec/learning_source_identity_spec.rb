# frozen_string_literal: true

require 'minitest/autorun'
require_relative '../bootstrap/learning_source_identity'

class LearningSourceIdentitySpec < Minitest::Test
  Account = Struct.new(:custom_attributes)
  Bot = Struct.new(:id, :account_id, :account)
  Token = Struct.new(:owner)

  def test_resolves_detached_existing_bots_without_any_write_or_binding_lookup
    tenants = %w[saas new_academy legacy_academy].each_with_index.map do |key, index|
      { 'key' => key, 'accountId' => index + 10, 'agentBotToken' => "synthetic-#{key}" }
    end
    tokens = Object.new
    tokens.define_singleton_method(:find_by!) do |owner_type:, token:|
      raise 'Unexpected owner type' unless owner_type == 'AgentBot'

      index = %w[saas new_academy legacy_academy].index(token.delete_prefix('synthetic-'))
      Token.new(Bot.new(index + 20, index + 10, Account.new({ 'myinvest_tenant_key' => %w[saas new_academy legacy_academy][index] })))
    end
    result = Myinvest::LearningSourceIdentity.new(tokens: tokens).call(tenants)
    assert_equal [20, 21, 22], result.map { |entry| entry.fetch('agentBotId') }
    refute tenants.any? { |entry| entry.key?('agentBotId') }
    result.first['agentBotId'] = 999
    assert_raises(RuntimeError) { Myinvest::LearningSourceIdentity.new(tokens: tokens).call(result) }
  end

  def test_refuses_an_identity_from_another_account
    tenants = %w[saas new_academy legacy_academy].map { |key| { 'key' => key, 'accountId' => 10, 'agentBotToken' => 'synthetic' } }
    tokens = Object.new
    tokens.define_singleton_method(:find_by!) { |**| Token.new(Bot.new(20, 11, Account.new({ 'myinvest_tenant_key' => 'saas' }))) }
    assert_raises(RuntimeError) { Myinvest::LearningSourceIdentity.new(tokens: tokens).call(tenants) }
  end
end
