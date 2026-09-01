require 'rails_helper'

RSpec.describe WebhookJob do
  include ActiveJob::TestHelper

  subject(:job) { described_class.perform_later(url, payload, webhook_type) }

  let(:url) { 'https://test.chatwoot.com' }
  let(:payload) { { name: 'test' } }
  let(:webhook_type) { :account_webhook }
  let(:retryable_error) { Webhooks::Trigger::RetryableError.new(status: 500, message: '500 Internal Server Error') }

  before do
    ActiveJob::Base.queue_adapter = :test
  end

  after do
    clear_enqueued_jobs
    clear_performed_jobs
  end

  it 'queues the job' do
    expect { job }.to have_enqueued_job(described_class)
      .with(url, payload, webhook_type)
      .on_queue('medium')
  end

  it 'executes perform with default webhook type' do
    expect(Webhooks::Trigger).to receive(:execute).with(url, payload, webhook_type, secret: nil, delivery_id: nil)
    perform_enqueued_jobs { job }
  end

  context 'with custom webhook type' do
    let(:webhook_type) { :api_inbox_webhook }

    it 'executes perform with inbox webhook type' do
      expect(Webhooks::Trigger).to receive(:execute).with(url, payload, webhook_type, secret: nil, delivery_id: nil)
      perform_enqueued_jobs { job }
    end
  end

  it 'bounds retries and records terminal failure for signed delivery webhooks' do
    allow(Webhooks::Trigger).to receive(:execute).and_raise(retryable_error)
    trigger_instance = instance_double(Webhooks::Trigger, handle_failure: true)
    allow(Webhooks::Trigger).to receive(:new).and_return(trigger_instance)

    expect(Webhooks::Trigger).to receive(:execute).exactly(3).times
    expect(Webhooks::Trigger).to receive(:new).with(
      url,
      payload,
      :api_inbox_webhook,
      secret: 'inbox-secret',
      delivery_id: 'delivery-123'
    ).once.and_return(trigger_instance)
    expect(trigger_instance).to receive(:handle_failure).with(retryable_error).once

    perform_enqueued_jobs do
      described_class.perform_later(
        url,
        payload,
        :api_inbox_webhook,
        secret: 'inbox-secret',
        delivery_id: 'delivery-123'
      )
    end
  end
end
