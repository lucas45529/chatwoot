class Email::SendOnEmailService < Base::SendOnChannelService
  private

  def channel_class
    Channel::Email
  end

  def perform_reply
    return unless message.email_notifiable_message?
    return if message.content_attributes['deleted'] == true
    return if native_reply? && !claim_native_attempt!

    reply_mail = ConversationReplyMailer.with(account: message.account).email_reply(message).deliver_now
    Rails.logger.info("Email message #{message.id} sent with source_id: #{reply_mail.message_id}")
    if native_reply?
      message.with_lock do
        message.update!(source_id: reply_mail.message_id, status: 'sent', external_error: nil,
                        content_attributes: message.content_attributes.merge('myinvest_email_send_state' => 'accepted'))
      end
    else
      message.update(source_id: reply_mail.message_id)
    end
  rescue StandardError => e
    ChatwootExceptionTracker.new(e, account: message.account).capture_exception
    if native_reply?
      message.with_lock do
        next if message.source_id.present?

        message.update!(status: 'failed', external_error: 'Email delivery is uncertain; reconcile before retry',
                        content_attributes: message.content_attributes.merge('myinvest_email_send_state' => 'unknown'))
      end
    else
      Messages::StatusUpdateService.new(message, 'failed', e.message).perform
    end
  end

  def native_reply?
    message.content_attributes['myinvest_email_reply'].is_a?(Hash)
  end

  def claim_native_attempt!
    message.with_lock do
      next false if message.content_attributes['myinvest_email_send_state'].present?

      message.update!(status: 'failed', external_error: 'Email delivery is pending confirmation',
                      content_attributes: message.content_attributes.merge('myinvest_email_send_state' => 'attempted'))
      true
    end
  end
end
