# Pin the server-verified envelope before Chatwoot queues the asynchronous mail job.
# Only replies carrying this explicit marker use this path; existing Email messages
# retain their original mailer behavior.
require 'digest'

class Messages::NativeEmailReplyContext
  KEY = 'myinvest_email_reply'.freeze
  MESSAGE_ID = /\A(?:<([^<>\s@]+@[^<>\s@]+)>|([^<>\s@]+@[^<>\s@]+))\z/
  ADDRESS = /\A([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)\z/
  NAMED_ADDRESS = /\A[^<>]*<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>\z/
  MAX_ATTACHMENT_BYTES = 5.megabytes
  MIME_BY_EXTENSION = { 'pdf' => 'application/pdf', 'png' => 'image/png', 'jpg' => 'image/jpeg',
                        'jpeg' => 'image/jpeg', 'webp' => 'image/webp' }.freeze
  PINNED_KEYS = %w[account_support_email attachments bcc cc channel_email in_reply_to
                   inbound_email_domain incoming_message_id references subject to].freeze

  def self.build!(conversation:, message:, request:, uploads: [])
    validate_outgoing!(conversation, message)
    validate_request_keys!(request)
    incoming = current_incoming!(conversation)
    identity = build_identity!(conversation, incoming, request)
    cc, bcc = build_copies!(message, incoming, request, identity[:to])
    attachments = build_attachments!(message, request, uploads)

    {
      'incoming_message_id' => incoming.id,
      'to' => identity[:to],
      'channel_email' => identity[:channel_email],
      'account_support_email' => identity[:support_email],
      'inbound_email_domain' => conversation.account.inbound_email_domain,
      'cc' => cc,
      'bcc' => bcc,
      'subject' => identity[:subject],
      'in_reply_to' => identity[:incoming_id],
      'references' => references_for!(incoming, identity[:incoming_id]),
      'attachments' => attachments
    }
  end

  def self.for_message!(message)
    raw = message.content_attributes&.dig(KEY)
    return nil unless raw

    fail_context unless raw.is_a?(Hash) && raw.keys.sort == PINNED_KEYS.sort
    conversation = message.conversation
    validate_outgoing!(conversation, message)
    fail_context unless message.account_id == conversation.account_id && message.inbox_id == conversation.inbox_id
    incoming = pinned_incoming!(conversation, message, raw)
    validate_pinned_identity!(conversation, incoming, raw)
    validate_pinned_copies!(message, incoming, raw)
    validate_pinned_headers!(incoming, raw)
    validate_pinned_attachments!(message, raw)

    raw
  end

  def self.message_id(value)
    return nil unless value.is_a?(String) && value.length <= 512

    match = MESSAGE_ID.match(value)
    match && "<#{match[1] || match[2]}>"
  end

  def self.mailbox(value)
    value = singleton_address(value)
    return nil unless value.is_a?(String) && value.length <= 320 && safe_header?(value)

    match = ADDRESS.match(value.strip) || NAMED_ADDRESS.match(value.strip)
    return nil unless match

    address = match[1]
    local, domain = address.split('@', 2)
    "#{local}@#{domain.downcase}"
  end

  def self.singleton_address(value)
    value.is_a?(Array) && value.one? ? value.first : value
  end

  def self.addresses(value, max:)
    return nil unless value.is_a?(Array) && value.size <= max

    normalized = value.map { |candidate| mailbox(candidate) }
    return nil if normalized.any?(&:nil?) || normalized.uniq.size != normalized.size

    normalized
  end

  def self.safe_header?(value)
    !value.match?(/[\x00-\x1f\x7f]/)
  end

  def self.fail_context
    raise ArgumentError, 'Invalid native email reply context'
  end

  def self.validate_outgoing!(conversation, message)
    fail_context unless conversation.inbox.email?
    fail_context unless message.outgoing? && !message.private?
  end

  def self.validate_request_keys!(request)
    valid_keys = [%w[bcc cc in_reply_to subject], %w[attachments bcc cc in_reply_to subject]]
    fail_context unless request.is_a?(Hash) && valid_keys.include?(request.keys.map(&:to_s).sort)
  end

  def self.current_incoming!(conversation)
    incoming = conversation.messages.incoming.where(private: false).last
    fail_context unless incoming && incoming.account_id == conversation.account_id
    fail_context unless incoming.inbox_id == conversation.inbox_id
    fail_context if incoming.auto_reply_email?

    incoming
  end

  def self.references_for!(incoming, incoming_id)
    references = incoming.content_attributes&.dig('email', 'references')
    references = references.nil? ? [] : Array.wrap(references)
    fail_context unless references.size <= 19
    normalized = normalize_references!(references)

    normalized.reject { |id| id == incoming_id }.uniq + [incoming_id]
  end

  def self.normalize_references!(references)
    normalized = references.map { |value| message_id(value) }
    fail_context if normalized.any?(&:nil?)
    normalized
  end
end

module Messages::NativeEmailReplyEnvelopeValidation
  def build_identity!(conversation, incoming, request)
    to = mailbox(conversation.contact&.email)
    channel_email = mailbox(conversation.inbox.channel.email)
    support_email = mailbox(conversation.account.support_email)
    incoming_id = message_id(incoming.content_attributes&.dig('email', 'message_id'))
    fail_context unless to && channel_email && support_email && incoming_id
    validate_requested_thread!(incoming, request, to, incoming_id)

    { to: to, channel_email: channel_email, support_email: support_email,
      incoming_id: incoming_id, subject: requested_subject!(conversation, request) }
  end

  def validate_requested_thread!(incoming, request, to, incoming_id)
    fail_context unless mailbox(incoming.content_attributes&.dig('email', 'from')) == to
    fail_context unless message_id(request.with_indifferent_access[:in_reply_to]) == incoming_id
  end

  def requested_subject!(conversation, request)
    subject = conversation.additional_attributes['mail_subject']
    fail_context unless subject.is_a?(String) && subject.length <= 496
    fail_context unless safe_header?(subject)
    expected = "Re: #{subject}"
    fail_context unless request.with_indifferent_access[:subject] == expected
    expected
  end

  def build_copies!(message, incoming, request, to)
    cc = addresses(request.with_indifferent_access[:cc], max: 10)
    bcc = addresses(request.with_indifferent_access[:bcc], max: 10)
    source_cc = addresses(Array.wrap(incoming.content_attributes&.dig('email', 'cc')), max: 20)
    validate_copies!(message, to, cc, bcc, source_cc)
    [cc, bcc]
  end

  def validate_copies!(message, to, cc, bcc, source_cc)
    fail_context unless cc && bcc && source_cc
    fail_context unless (cc - source_cc).empty?
    validate_copy_recipients!(to, cc, bcc)
    validate_message_recipients!(message, to, cc, bcc)
  end

  def validate_message_recipients!(message, to, cc, bcc)
    fail_context unless message.content_attributes['to_emails'] == [to]
    fail_context unless message.content_attributes['cc_emails'] == cc
    fail_context unless message.content_attributes['bcc_emails'] == bcc
  end

  def validate_copy_recipients!(to, cc, bcc)
    fail_context if [to].intersect?(cc + bcc)
    fail_context if cc.intersect?(bcc)
  end

  def pinned_incoming!(conversation, message, raw)
    incoming = conversation.messages.incoming.where(id: raw['incoming_message_id'], account_id: conversation.account_id,
                                                    inbox_id: conversation.inbox_id, private: false).first
    fail_context unless incoming && incoming.id < message.id
    fail_context if incoming.auto_reply_email?
    incoming
  end

  def validate_pinned_identity!(conversation, incoming, raw)
    validate_pinned_source!(incoming, raw)
    validate_current_mailboxes!(conversation, raw)
  end

  def validate_pinned_source!(incoming, raw)
    fail_context unless message_id(incoming.content_attributes&.dig('email', 'message_id')) == raw['in_reply_to']
    fail_context unless mailbox(incoming.content_attributes&.dig('email', 'from')) == raw['to']
  end

  def validate_current_mailboxes!(conversation, raw)
    fail_context unless mailbox(conversation.contact&.reload&.email) == raw['to']
    fail_context unless mailbox(conversation.inbox.reload.channel.reload.email) == raw['channel_email']
    fail_context unless mailbox(conversation.account.reload.support_email) == raw['account_support_email']
    fail_context unless conversation.account.inbound_email_domain == raw['inbound_email_domain']
  end

  def validate_pinned_copies!(message, incoming, raw)
    cc = addresses(raw['cc'], max: 10)
    bcc = addresses(raw['bcc'], max: 10)
    source_cc = addresses(Array.wrap(incoming.content_attributes&.dig('email', 'cc')), max: 20)
    fail_context unless cc == raw['cc'] && bcc == raw['bcc']
    validate_copies!(message, raw['to'], cc, bcc, source_cc)
  end

  def validate_pinned_headers!(incoming, raw)
    validate_pinned_subject!(raw['subject'])
    validate_pinned_references!(raw)
    fail_context unless raw['references'] == references_for!(incoming, raw['in_reply_to'])
  end

  def validate_pinned_subject!(subject)
    fail_context unless subject.is_a?(String) && subject.length <= 500
    fail_context unless safe_header?(subject)
  end

  def validate_pinned_references!(raw)
    references = raw['references']
    fail_context unless references.is_a?(Array) && references.size.between?(1, 20)
    fail_context unless references.all? { |value| message_id(value) == value }
    fail_context unless references.last == raw['in_reply_to']
  end
end

module Messages::NativeEmailReplyAttachmentValidation
  MAX_ATTACHMENT_BYTES = Messages::NativeEmailReplyContext::MAX_ATTACHMENT_BYTES
  MIME_BY_EXTENSION = Messages::NativeEmailReplyContext::MIME_BY_EXTENSION

  def build_attachments!(message, request, uploads)
    metadata = attachment_metadata(request.with_indifferent_access[:attachments] || [])
    fail_context unless metadata && uploads.size == metadata.size
    fail_context unless message.attachments.size == uploads.size
    uploads.each_with_index { |upload, index| validate_upload!(upload, metadata[index]) }
    metadata
  end

  def validate_upload!(upload, metadata)
    fail_context unless upload.respond_to?(:tempfile) && upload.respond_to?(:original_filename)
    bytes = upload.tempfile.read(MAX_ATTACHMENT_BYTES + 1)
    upload.tempfile.rewind
    fail_context unless attachment_bytes?(bytes, metadata['mime'])
    fail_context unless metadata == {
      'name' => upload.original_filename, 'mime' => upload.content_type,
      'size' => bytes.bytesize, 'sha256' => Digest::SHA256.hexdigest(bytes)
    }
  end

  def validate_pinned_attachments!(message, raw)
    metadata = attachment_metadata(raw['attachments'])
    fail_context unless metadata && metadata == raw['attachments']
    fail_context unless message.attachments.size == metadata.size
    message.attachments.each_with_index { |attachment, index| validate_blob!(attachment.file.blob, metadata[index]) }
  end

  def validate_blob!(blob, metadata)
    fail_context unless blob && blob.byte_size == metadata['size']
    fail_context unless blob.content_type == metadata['mime'] && blob.filename.to_s == metadata['name']
    bytes = blob.download
    fail_context unless attachment_bytes?(bytes, metadata['mime'])
    fail_context unless Digest::SHA256.hexdigest(bytes) == metadata['sha256']
  end

  def attachment_metadata(value)
    return nil unless valid_attachment_list?(value)

    normalized = value.map { |entry| normalize_attachment_entry(entry) }
    return nil if normalized.any?(&:nil?)
    return nil if normalized.sum { |item| item['size'] } > MAX_ATTACHMENT_BYTES * 2

    normalized
  end

  def valid_attachment_list?(value)
    value.is_a?(Array) && value.size <= 2
  end

  def normalize_attachment_entry(entry)
    return nil unless entry.is_a?(Hash) && entry.keys.map(&:to_s).sort == %w[mime name sha256 size]

    item = entry.with_indifferent_access
    name = item[:name]
    mime = item[:mime]
    size = item[:size]
    sha256 = item[:sha256]
    return nil unless valid_attachment_name?(name)
    return nil unless valid_attachment_type_and_size?(name, mime, size)
    return nil unless valid_attachment_hash?(sha256)

    { 'name' => name, 'mime' => mime, 'size' => size, 'sha256' => sha256 }
  end

  def valid_attachment_name?(name)
    name.is_a?(String) && name.length.between?(1, 120) && !name.match?(%r{[\\/\x00-\x1f\x7f]})
  end

  def valid_attachment_type_and_size?(name, mime, size)
    mime == MIME_BY_EXTENSION[name.split('.').last.to_s.downcase] &&
      size.is_a?(Integer) && size.between?(1, MAX_ATTACHMENT_BYTES)
  end

  def valid_attachment_hash?(sha256)
    sha256.is_a?(String) && sha256.match?(/\A[a-f0-9]{64}\z/)
  end

  def attachment_bytes?(bytes, mime)
    return false unless bytes.is_a?(String) && bytes.bytesize.between?(9, MAX_ATTACHMENT_BYTES)
    return pdf_bytes?(bytes) if mime == 'application/pdf'

    image_bytes?(bytes, mime)
  end

  def image_bytes?(bytes, mime)
    case mime
    when 'image/png' then bytes.start_with?("\x89PNG\r\n\x1a\n".b)
    when 'image/jpeg' then bytes.start_with?("\xff\xd8\xff".b)
    when 'image/webp' then bytes.start_with?('RIFF') && bytes.byteslice(8, 4) == 'WEBP'
    else false
    end
  end

  def pdf_bytes?(bytes)
    bytes.byteslice(0, 8).match?(/\A%PDF-[12]\.\d/) &&
      bytes.byteslice([bytes.bytesize - 1024, 0].max, 1024).match?(/%%EOF\s*\z/n)
  end
end

Messages::NativeEmailReplyContext.extend(Messages::NativeEmailReplyEnvelopeValidation)
Messages::NativeEmailReplyContext.extend(Messages::NativeEmailReplyAttachmentValidation)
