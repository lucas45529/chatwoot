require 'rails_helper'

describe Email::SendOnEmailService do
  let(:account) { create(:account) }
  let(:email_channel) { create(:channel_email, account: account) }
  let(:inbox) { create(:inbox, account: account, channel: email_channel) }
  let(:conversation) { create(:conversation, account: account, inbox: inbox) }
  let(:message) { create(:message, conversation: conversation, message_type: 'outgoing') }
  let(:service) { described_class.new(message: message) }

  describe '#perform' do
    let(:mailer_context) { instance_double(ConversationReplyMailer) }
    let(:delivery) { instance_double(ActionMailer::MessageDelivery) }
    let(:email_message) { instance_double(Mail::Message) }

    before do
      allow(ConversationReplyMailer).to receive(:with).with(account: message.account).and_return(mailer_context)
    end

    context 'when message is email notifiable' do
      before do
        allow(mailer_context).to receive(:email_reply).with(message).and_return(delivery)
        allow(delivery).to receive(:deliver_now).and_return(email_message)
        allow(email_message).to receive(:message_id).and_return(
          "conversation/#{conversation.uuid}/messages/" \
          "#{message.id}@#{conversation.account.domain}"
        )
      end

      it 'sends email via ConversationReplyMailer' do
        service.perform

        expect(ConversationReplyMailer).to have_received(:with).with(account: message.account)
        expect(mailer_context).to have_received(:email_reply).with(message)
        expect(delivery).to have_received(:deliver_now)
      end

      it 'updates message source id on success' do
        service.perform

        expect(message.reload.source_id).to eq("conversation/#{conversation.uuid}/messages/#{message.id}@#{conversation.account.domain}")
      end
    end

    context 'when the message is a native email reply' do
      let(:agent) { create(:user, account: account) }
      let(:native_message) do
        conversation.contact.update!(email: 'customer@example.com')
        conversation.update!(additional_attributes: { 'mail_subject' => 'Question' })
        create(:message, conversation: conversation, account: account, message_type: :incoming,
                         content_attributes: { email: { from: 'customer@example.com', message_id: 'first@example.com' } })
        Messages::MessageBuilder.new(agent, conversation, ActionController::Parameters.new(
          content: 'The answer', message_type: 'outgoing', to_emails: 'customer@example.com',
          cc_emails: '', bcc_emails: '', content_attributes: {
            myinvest_native_request_id: SecureRandom.uuid,
            myinvest_email_reply: { subject: 'Re: Question', in_reply_to: '<first@example.com>', cc: [], bcc: [] }
          }
        )).perform
      end
      let(:native_mailer_context) { instance_double(ConversationReplyMailer) }
      let(:native_delivery) { instance_double(ActionMailer::MessageDelivery) }
      let(:native_email) { instance_double(Mail::Message, message_id: 'native-delivered@example.com') }

      before do
        allow(ConversationReplyMailer).to receive(:with).with(account: account).and_return(native_mailer_context)
        allow(native_mailer_context).to receive(:email_reply).with(native_message).and_return(native_delivery)
        allow(native_delivery).to receive(:deliver_now).and_return(native_email)
      end

      it 'sends through the real job once, then ignores a duplicate job' do
        SendReplyJob.perform_now(native_message.id)
        SendReplyJob.perform_now(native_message.id)

        expect(native_delivery).to have_received(:deliver_now).once
        expect(native_message.reload.source_id).to eq('native-delivered@example.com')
        expect(native_message.content_attributes['myinvest_email_send_state']).to eq('accepted')
      end

      it 'keeps an uncertain SMTP attempt from being sent by a retry' do
        allow(native_delivery).to receive(:deliver_now).and_raise(Net::ReadTimeout)
        SendReplyJob.perform_now(native_message.id)
        SendReplyJob.perform_now(native_message.id)

        expect(native_delivery).to have_received(:deliver_now).once
        expect(native_message.reload.source_id).to be_nil
        expect(native_message.content_attributes['myinvest_email_send_state']).to eq('unknown')
      end

      it 'does not send a message whose context was removed by deletion' do
        native_message.update!(content: 'This message was deleted', content_attributes: { deleted: true })

        SendReplyJob.perform_now(native_message.id)

        expect(native_delivery).not_to have_received(:deliver_now)
      end
    end

    context 'when message is not email notifiable' do
      let(:message) { create(:message, conversation: conversation, message_type: 'incoming') }

      before do
        allow(mailer_context).to receive(:email_reply)
      end

      it 'does not send email' do
        service.perform

        expect(ConversationReplyMailer).not_to have_received(:with)
        expect(mailer_context).not_to have_received(:email_reply)
      end
    end

    context 'when an error occurs' do
      let(:error_message) { 'SMTP connection failed' }
      let(:error) { StandardError.new(error_message) }
      let(:exception_tracker) { instance_double(ChatwootExceptionTracker, capture_exception: true) }
      let(:status_service) { instance_double(Messages::StatusUpdateService, perform: true) }

      before do
        allow(mailer_context).to receive(:email_reply).with(message).and_return(delivery)
        allow(delivery).to receive(:deliver_now).and_raise(error)
        allow(ChatwootExceptionTracker).to receive(:new).and_return(exception_tracker)
      end

      it 'captures the exception' do
        expect(ChatwootExceptionTracker).to receive(:new).with(error, account: message.account)

        service.perform
      end

      it 'updates message status to failed' do
        service.perform

        expect(message.reload.status).to eq('failed')
        expect(message.reload.external_error).to eq(error_message)
      end
    end
  end
end
