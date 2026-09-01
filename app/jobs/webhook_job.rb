class WebhookJob < ApplicationJob
  queue_as :medium
  retry_on Webhooks::Trigger::RetryableError, wait: 3.seconds, attempts: 3 do |job, error|
    url, payload, webhook_type, raw_options = job.arguments
    options = raw_options.is_a?(Hash) ? raw_options.symbolize_keys : {}
    Webhooks::Trigger.new(
      url,
      payload,
      webhook_type || :account_webhook,
      secret: options[:secret],
      delivery_id: options[:delivery_id]
    ).handle_failure(error)
  end

  def perform(url, payload, webhook_type = :account_webhook, secret: nil, delivery_id: nil)
    Webhooks::Trigger.execute(url, payload, webhook_type, secret: secret, delivery_id: delivery_id)
  end
end
