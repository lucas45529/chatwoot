# frozen_string_literal: true

# Chatwoot's signed AgentBot jobs carry the webhook secret as an internal job
# argument. Keep Active Job arguments out of production logs.
ActiveJob::Base.log_arguments = false

Rails.application.config.after_initialize do
  # Narrow extension: the account-scoped AgentBot may read/write the one shared
  # composer draft for its conversation. It still cannot read users, contacts,
  # arbitrary messages, or any other new endpoint.
  draft_controller = 'api/v1/accounts/conversations/draft_messages'
  draft_actions = %w[show update]
  endpoints = AccessTokenAuthHelper::BOT_ACCESSIBLE_ENDPOINTS
  unless (draft_actions - endpoints.fetch(draft_controller, [])).empty?
    patched = endpoints.merge(draft_controller => draft_actions).freeze
    AccessTokenAuthHelper.send(:remove_const, :BOT_ACCESSIBLE_ENDPOINTS)
    AccessTokenAuthHelper.const_set(:BOT_ACCESSIBLE_ENDPOINTS, patched)
  end

  AgentBots::WebhookJob.class_eval do
    define_method(:perform) do |url, payload, webhook_type = :agent_bot_webhook, secret: nil, delivery_id: nil|
      Webhooks::Trigger.execute(
        url, payload, webhook_type, secret: secret, delivery_id: delivery_id
      )
    rescue Webhooks::Trigger::RetryableError => error
      Rails.logger.warn(
        "[AgentBots::WebhookJob] attempt #{executions} failed #{error.class.name}"
      )
      raise
    end
  end
end
