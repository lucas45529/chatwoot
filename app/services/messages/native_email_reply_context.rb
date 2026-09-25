# Pin the server-verified envelope before Chatwoot queues the asynchronous mail job.
# Only replies carrying this explicit marker use this path; existing Email messages
# retain their original mailer behavior.
class Messages::NativeEmailReplyContext
  KEY = 'myinvest_email_reply'.freeze
  MESSAGE_ID = /\A(?:<([^<>\s@]+@[^<>\s@]+)>|([^<>\s@]+@[^<>\s@]+))\z/
  ADDRESS = /\A([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)\z/
  NAMED_ADDRESS = /\A[^<>]*<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>\z/

  def self.build!(conversation:, message:, request:)
    fail_context unless conversation.inbox.email? && message.outgoing? && !message.private?
    fail_context unless request.is_a?(Hash) && request.keys.map(&:to_s).sort == %w[in_reply_to subject]

    incoming = conversation.messages.incoming.where(private: false).last
    fail_context unless incoming && incoming.account_id == conversation.account_id && incoming.inbox_id == conversation.inbox_id

    contact = mailbox(conversation.contact&.email)
    from = mailbox(incoming.content_attributes&.dig('email', 'from'))
    incoming_id = message_id(incoming.content_attributes&.dig('email', 'message_id'))
    requested_id = message_id(request.with_indifferent_access[:in_reply_to])
    subject = conversation.additional_attributes['mail_subject']
    expected_subject = "Re: #{subject}"
    fail_context unless contact && from == contact && incoming_id && requested_id == incoming_id
    fail_context unless subject.is_a?(String) && subject.length <= 496 && safe_header?(subject)
    fail_context unless request.with_indifferent_access[:subject] == expected_subject
    fail_context unless message.content_attributes['to_emails'] == [contact]
    fail_context unless message.content_attributes['cc_emails'] == [] && message.content_attributes['bcc_emails'] == []

    references = incoming.content_attributes&.dig('email', 'references')
    references = references.nil? ? [] : Array.wrap(references)
    fail_context unless references.size <= 19
    normalized_references = references.map { |value| message_id(value) }
    fail_context if normalized_references.any?(&:nil?)

    {
      'incoming_message_id' => incoming.id,
      'to' => contact,
      'subject' => expected_subject,
      'in_reply_to' => incoming_id,
      'references' => (normalized_references.reject { |id| id == incoming_id }.uniq + [incoming_id])
    }
  end

  def self.for_message!(message)
    raw = message.content_attributes&.dig(KEY)
    return nil unless raw

    fail_context unless raw.is_a?(Hash) && raw.keys.sort == %w[in_reply_to incoming_message_id references subject to]
    conversation = message.conversation
    fail_context unless conversation.inbox.email? && message.outgoing? && !message.private?
    fail_context unless message.account_id == conversation.account_id && message.inbox_id == conversation.inbox_id
    incoming = conversation.messages.incoming.where(id: raw['incoming_message_id'], account_id: conversation.account_id,
                                                    inbox_id: conversation.inbox_id, private: false).first
    fail_context unless incoming && incoming.id < message.id
    fail_context unless message_id(incoming.content_attributes&.dig('email', 'message_id')) == raw['in_reply_to']
    fail_context unless mailbox(incoming.content_attributes&.dig('email', 'from')) == raw['to']
    fail_context unless mailbox(conversation.contact&.email) == raw['to']
    fail_context unless message.content_attributes['to_emails'] == [raw['to']]
    fail_context unless message.content_attributes['cc_emails'] == [] && message.content_attributes['bcc_emails'] == []
    fail_context unless raw['subject'].is_a?(String) && raw['subject'].length <= 500 && safe_header?(raw['subject'])
    fail_context unless raw['references'].is_a?(Array) && raw['references'].size.between?(1, 20)
    fail_context unless raw['references'].all? { |value| message_id(value) == value }
    fail_context unless raw['references'].last == raw['in_reply_to']
    source_references = incoming.content_attributes&.dig('email', 'references')
    source_references = source_references.nil? ? [] : Array.wrap(source_references)
    fail_context unless source_references.size <= 19
    normalized_references = source_references.map { |value| message_id(value) }
    fail_context if normalized_references.any?(&:nil?)
    expected_references = normalized_references.reject { |id| id == raw['in_reply_to'] }.uniq + [raw['in_reply_to']]
    fail_context unless raw['references'] == expected_references

    raw
  end

  def self.message_id(value)
    return nil unless value.is_a?(String) && value.length <= 512

    match = MESSAGE_ID.match(value)
    match && "<#{match[1] || match[2]}>"
  end

  def self.mailbox(value)
    value = value.first if value.is_a?(Array) && value.one?
    return nil unless value.is_a?(String) && value.length <= 320 && safe_header?(value)

    match = ADDRESS.match(value.strip) || NAMED_ADDRESS.match(value.strip)
    return nil unless match

    address = match[1]
    local, domain = address.split('@', 2)
    "#{local}@#{domain.downcase}"
  end

  def self.safe_header?(value)
    !value.match?(/[\x00-\x1f\x7f]/)
  end

  def self.fail_context
    raise ArgumentError, 'Invalid native email reply context'
  end
end
