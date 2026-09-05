# frozen_string_literal: true

require 'json'

# Deployment-only policy: retain synthetic audit records while keeping the real
# support inbox and its counts useful. Never infer test data from a contact name.
module MyinvestSupportReview
  TENANTS = %w[saas new_academy legacy_academy].freeze
  RETIRED_TEST = JSON.generate('myinvest_e2e_retired' => true).freeze
  RECOVERY_MARKER = '^production-e2e-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{32}$'.freeze
  VISIBLE_CONVERSATIONS = <<~SQL.freeze
    NOT (COALESCE(conversations.custom_attributes @> ?::jsonb, FALSE)
      AND COALESCE(conversations.custom_attributes ->> 'myinvest_production_e2e_recovery' ~ ?, FALSE))
  SQL

  def self.managed?(account)
    attributes = account.custom_attributes || {}
    attributes['managed_by'] == 'myinvest-bootstrap' && TENANTS.include?(attributes['myinvest_tenant_key'])
  end

  def self.visible(relation, account)
    return relation unless managed?(account)

    relation.where(VISIBLE_CONVERSATIONS, RETIRED_TEST, RECOVERY_MARKER)
  end

  VISIBLE_MESSAGES = <<~SQL.freeze
    NOT EXISTS (SELECT 1 FROM conversations
      WHERE conversations.id = messages.conversation_id
        AND conversations.account_id = messages.account_id
        AND NOT (#{VISIBLE_CONVERSATIONS}))
  SQL
  VISIBLE_CONTACTS = <<~SQL.freeze
    (NOT EXISTS (SELECT 1 FROM conversations
      WHERE conversations.contact_id = contacts.id AND conversations.account_id = contacts.account_id)
    OR EXISTS (SELECT 1 FROM conversations
      WHERE conversations.contact_id = contacts.id AND conversations.account_id = contacts.account_id
        AND #{VISIBLE_CONVERSATIONS}))
  SQL

  def self.visible_messages(relation, account)
    return relation unless managed?(account)

    relation.where(VISIBLE_MESSAGES, RETIRED_TEST, RECOVERY_MARKER)
  end

  def self.visible_contacts(relation, account)
    return relation unless managed?(account)

    relation.where(VISIBLE_CONTACTS, RETIRED_TEST, RECOVERY_MARKER)
  end

  module Finder
    private

    def set_up
      super
      @conversations = MyinvestSupportReview.visible(@conversations, current_account)
    end
  end

  module Filter
    def base_relation
      MyinvestSupportReview.visible(super, @account)
    end
  end

  module Search
    private

    def filter_conversations
      @conversations = MyinvestSupportReview.visible(super, current_account)
    end

    def message_base_query
      MyinvestSupportReview.visible_messages(super, current_account)
    end

    def should_run_advanced_search?
      # The search index does not carry retirement markers. Managed support
      # uses the existing PostgreSQL GIN/LIKE path so withdrawal is immediate.
      return false if MyinvestSupportReview.managed?(current_account)

      super
    end

    def filter_contacts
      @contacts = MyinvestSupportReview.visible_contacts(super, current_account)
    end
  end

  module Assignment
    private

    def myinvest_assign_support_reviewer
      return if assignee_id
      return unless MyinvestSupportReview.managed?(account) && account.custom_attributes['myinvest_tenant_key'] == 'saas'

      # The internal support identity, not the bootstrap SuperAdmin, owns review.
      # Membership is required; online status and round-robin capacity are not.
      reviewer = account.users.find_by!(email: ENV.fetch('INTERN_SSO_EMAIL'))
      raise 'MyInvest support reviewer must belong to the conversation inbox' unless inbox.members.exists?(id: reviewer.id)

      self.assignee = reviewer
      self.assignee_agent_bot = nil
    end
  end
end

Rails.application.config.to_prepare do
  ConversationFinder.prepend(MyinvestSupportReview::Finder) unless ConversationFinder < MyinvestSupportReview::Finder
  Conversations::FilterService.prepend(MyinvestSupportReview::Filter) unless Conversations::FilterService < MyinvestSupportReview::Filter
  SearchService.prepend(MyinvestSupportReview::Search) unless SearchService < MyinvestSupportReview::Search
  unless Conversation < MyinvestSupportReview::Assignment
    Conversation.include(MyinvestSupportReview::Assignment)
    Conversation.before_create :myinvest_assign_support_reviewer
  end
end
