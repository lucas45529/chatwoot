# frozen_string_literal: true

require 'minitest/autorun'
require 'ostruct'
require 'json'

# No Rails boot required: exercise the mounted extension's contracts and callback.
module Rails
  class Configuration
    def to_prepare
      # Production Rails invokes this after its classes are autoloadable.
    end
  end

  def self.application
    @application ||= OpenStruct.new(config: Configuration.new)
  end
end

require_relative '../chatwoot-initializers/myinvest_support_review'

class SupportReviewInitializerTest < Minitest::Test
  class Relation
    attr_reader :conditions

    def where(*conditions)
      @conditions = conditions
      self
    end
  end

  class Members
    def initialize(user)
      @user = user
    end

    def find_by!(email:)
      raise 'wrong reviewer identity' unless email == @user.email

      @user
    end

    def exists?(id:)
      @user && id == @user.id
    end
  end

  class DraftConversation
    include MyinvestSupportReview::Assignment
    attr_accessor :account, :inbox, :assignee, :assignee_agent_bot

    def initialize(account:, inbox:)
      @account = account
      @inbox = inbox
    end

    def assignee_id
      assignee&.id
    end
  end

  def setup
    @previous_email = ENV['INTERN_SSO_EMAIL']
    ENV['INTERN_SSO_EMAIL'] = 'reviewer@example.invalid'
    @user = OpenStruct.new(id: 4, email: ENV.fetch('INTERN_SSO_EMAIL'))
  end

  def teardown
    ENV['INTERN_SSO_EMAIL'] = @previous_email
  end

  def account(tenant = 'saas', managed = 'myinvest-bootstrap')
    OpenStruct.new(custom_attributes: { 'managed_by' => managed, 'myinvest_tenant_key' => tenant }, users: Members.new(@user))
  end

  def test_filter_requires_boolean_retirement_and_recovery_marker_and_handles_missing_attributes
    relation = Relation.new
    assert_same relation, MyinvestSupportReview.visible(relation, account)
    sql, retirement, recovery = relation.conditions
    assert_equal({ 'myinvest_e2e_retired' => true }, JSON.parse(retirement))
    assert_equal 'production-e2e-%', recovery
    assert_match(/NOT \(COALESCE\(conversations.custom_attributes @> \?::jsonb, FALSE\)\s+AND COALESCE/m, sql)
    assert_includes sql, "conversations.custom_attributes ->> 'myinvest_production_e2e_recovery' LIKE ?, FALSE)"
    refute_match(/status|contacts|name/i, sql)
  end

  def test_other_accounts_and_unmanaged_tenant_names_are_not_filtered
    [account('other'), account('saas', 'unrelated')].each do |other|
      relation = Relation.new
      assert_same relation, MyinvestSupportReview.visible(relation, other)
      assert_nil relation.conditions
    end
  end

  def test_all_three_managed_tenants_hide_retired_tests
    %w[saas new_academy legacy_academy].each do |tenant|
      relation = Relation.new
      MyinvestSupportReview.visible(relation, account(tenant))
      refute_nil relation.conditions
    end
  end

  def test_new_saas_conversation_is_assigned_to_inbox_reviewer_even_when_offline
    conversation = DraftConversation.new(account: account, inbox: OpenStruct.new(members: Members.new(@user)))
    conversation.assignee_agent_bot = Object.new
    2.times { conversation.send(:myinvest_assign_support_reviewer) }
    assert_same @user, conversation.assignee
    assert_nil conversation.assignee_agent_bot
  end

  def test_explicit_human_assignment_is_preserved
    conversation = DraftConversation.new(account: account, inbox: nil)
    human = OpenStruct.new(id: 9)
    conversation.assignee = human
    conversation.send(:myinvest_assign_support_reviewer)
    assert_same human, conversation.assignee
  end

  def test_academy_and_unmanaged_accounts_keep_existing_routing
    [account('new_academy'), account('legacy_academy'), account('saas', 'unrelated')].each do |other|
      conversation = DraftConversation.new(account: other, inbox: nil)
      conversation.send(:myinvest_assign_support_reviewer)
      assert_nil conversation.assignee
    end
  end

  def test_missing_inbox_membership_never_assigns_an_ineligible_user
    conversation = DraftConversation.new(account: account, inbox: OpenStruct.new(members: Members.new(nil)))
    assert_raises(RuntimeError) { conversation.send(:myinvest_assign_support_reviewer) }
    assert_nil conversation.assignee
  end
end
