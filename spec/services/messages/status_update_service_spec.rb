require 'rails_helper'

describe Messages::StatusUpdateService do
  let(:account) { create(:account) }
  let(:conversation) { create(:conversation, account: account) }
  let(:message) { create(:message, conversation: conversation, account: account) }

  describe '#perform' do
    context 'when status is valid' do
      it 'updates the status of the message' do
        service = described_class.new(message, 'delivered')
        service.perform
        expect(message.reload.status).to eq('delivered')
      end

      it 'clears external_error when status is not failed' do
        message.update!(status: 'failed', external_error: 'previous error')
        service = described_class.new(message, 'delivered')
        service.perform
        expect(message.reload.status).to eq('delivered')
        expect(message.reload.external_error).to be_nil
      end

      it 'updates external_error when status is failed' do
        service = described_class.new(message, 'failed', 'some error')
        service.perform
        expect(message.reload.status).to eq('failed')
        expect(message.reload.external_error).to eq('some error')
      end
    end

    context 'when status is invalid' do
      it 'returns false for invalid status' do
        service = described_class.new(message, 'invalid_status')
        expect(service.perform).to be false
      end

      [
        %w[delivered sent],
        %w[read sent],
        %w[read delivered]
      ].each do |current_status, requested_status|
        it "prevents transition from #{current_status} back to #{requested_status}" do
          message.update!(status: current_status)
          service = described_class.new(message, requested_status)

          expect(service.perform).to be false
          expect(message.reload.status).to eq(current_status)
        end
      end

      it 'reloads a stale message while locking before checking the transition' do
        stale_message = Message.find(message.id)
        message.update!(status: 'read')
        expect(stale_message.status).to eq('sent')

        service = described_class.new(stale_message, 'sent')

        expect(service.perform).to be false
        expect(message.reload.status).to eq('read')
      end
    end
  end
end
