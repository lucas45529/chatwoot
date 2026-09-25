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
    fail_context unless conversation.inbox.email? && message.outgoing? && !message.private?
    fail_context unless request.is_a?(Hash) &&
                        [%w[bcc cc in_reply_to subject], %w[attachments bcc cc in_reply_to subject]].include?(request.keys.map(&:to_s).sort)

    incoming = conversation.messages.incoming.where(private: false).last
    fail_context unless incoming && incoming.account_id == conversation.account_id && incoming.inbox_id == conversation.inbox_id
    fail_context if incoming.auto_reply_email?

    contact = mailbox(conversation.contact&.email)
    channel_email = mailbox(conversation.inbox.channel.email)
    support_email = mailbox(conversation.account.support_email)
    from = mailbox(incoming.content_attributes&.dig('email', 'from'))
    incoming_id = message_id(incoming.content_attributes&.dig('email', 'message_id'))
    requested_id = message_id(request.with_indifferent_access[:in_reply_to])
    subject = conversation.additional_attributes['mail_subject']
    expected_subject = "Re: #{subject}"
    fail_context unless contact && channel_email && support_email && from == contact && incoming_id && requested_id == incoming_id
    fail_context unless subject.is_a?(String) && subject.length <= 496 && safe_header?(subject)
    fail_context unless request.with_indifferent_access[:subject] == expected_subject
    chosen_cc = addresses(request.with_indifferent_access[:cc], max: 10)
    chosen_bcc = addresses(request.with_indifferent_access[:bcc], max: 10)
    source_cc = addresses(Array.wrap(incoming.content_attributes&.dig('email', 'cc')), max: 20)
    fail_context unless chosen_cc && chosen_bcc && source_cc
    fail_context unless (chosen_cc - source_cc).empty?
    fail_context if [contact].intersect?(chosen_cc + chosen_bcc) || chosen_cc.intersect?(chosen_bcc)
    fail_context unless message.content_attributes['to_emails'] == [contact]
    fail_context unless message.content_attributes['cc_emails'] == chosen_cc
    fail_context unless message.content_attributes['bcc_emails'] == chosen_bcc

    references = incoming.content_attributes&.dig('email', 'references')
    references = references.nil? ? [] : Array.wrap(references)
    fail_context unless references.size <= 19
    normalized_references = references.map { |value| message_id(value) }
    fail_context if normalized_references.any?(&:nil?)
    requested_attachments = attachment_metadata(request.with_indifferent_access[:attachments] || [])
    fail_context unless requested_attachments && uploads.size == requested_attachments.size && message.attachments.size == uploads.size
    uploads.each_with_index do |upload, index|
      fail_context unless upload.respond_to?(:tempfile) && upload.respond_to?(:original_filename)
      bytes = upload.tempfile.read(MAX_ATTACHMENT_BYTES + 1)
      upload.tempfile.rewind
      fail_context unless attachment_bytes?(bytes, requested_attachments[index]['mime'])
      fail_context unless requested_attachments[index] == {
        'name' => upload.original_filename, 'mime' => upload.content_type,
        'size' => bytes.bytesize, 'sha256' => Digest::SHA256.hexdigest(bytes)
      }
    end

    {
      'incoming_message_id' => incoming.id,
      'to' => contact,
      'channel_email' => channel_email,
      'account_support_email' => support_email,
      'inbound_email_domain' => conversation.account.inbound_email_domain,
      'cc' => chosen_cc,
      'bcc' => chosen_bcc,
      'subject' => expected_subject,
      'in_reply_to' => incoming_id,
      'references' => (normalized_references.reject { |id| id == incoming_id }.uniq + [incoming_id]),
      'attachments' => requested_attachments
    }
  end

  def self.for_message!(message)
    raw = message.content_attributes&.dig(KEY)
    return nil unless raw

    fail_context unless raw.is_a?(Hash) && raw.keys.sort == PINNED_KEYS.sort
    conversation = message.conversation
    fail_context unless conversation.inbox.email? && message.outgoing? && !message.private?
    fail_context unless message.account_id == conversation.account_id && message.inbox_id == conversation.inbox_id
    incoming = conversation.messages.incoming.where(id: raw['incoming_message_id'], account_id: conversation.account_id,
                                                    inbox_id: conversation.inbox_id, private: false).first
    fail_context unless incoming && incoming.id < message.id
    fail_context if incoming.auto_reply_email?
    fail_context unless message_id(incoming.content_attributes&.dig('email', 'message_id')) == raw['in_reply_to']
    fail_context unless mailbox(incoming.content_attributes&.dig('email', 'from')) == raw['to']
    fail_context unless mailbox(conversation.contact&.reload&.email) == raw['to']
    fail_context unless mailbox(conversation.inbox.reload.channel.reload.email) == raw['channel_email']
    fail_context unless mailbox(conversation.account.reload.support_email) == raw['account_support_email']
    fail_context unless conversation.account.inbound_email_domain == raw['inbound_email_domain']
    chosen_cc = addresses(raw['cc'], max: 10)
    chosen_bcc = addresses(raw['bcc'], max: 10)
    source_cc = addresses(Array.wrap(incoming.content_attributes&.dig('email', 'cc')), max: 20)
    fail_context unless chosen_cc == raw['cc'] && chosen_bcc == raw['bcc'] && source_cc
    fail_context unless (chosen_cc - source_cc).empty?
    fail_context if [raw['to']].intersect?(chosen_cc + chosen_bcc) || chosen_cc.intersect?(chosen_bcc)
    fail_context unless message.content_attributes['to_emails'] == [raw['to']]
    fail_context unless message.content_attributes['cc_emails'] == chosen_cc
    fail_context unless message.content_attributes['bcc_emails'] == chosen_bcc
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
    pinned_attachments = attachment_metadata(raw['attachments'])
    fail_context unless pinned_attachments && pinned_attachments == raw['attachments'] &&
                        message.attachments.size == pinned_attachments.size
    message.attachments.each_with_index do |attachment, index|
      blob = attachment.file.blob
      fail_context unless blob && blob.byte_size == pinned_attachments[index]['size'] &&
                          blob.content_type == pinned_attachments[index]['mime'] &&
                          blob.filename.to_s == pinned_attachments[index]['name']
      bytes = blob.download
      fail_context unless attachment_bytes?(bytes, pinned_attachments[index]['mime']) &&
                          Digest::SHA256.hexdigest(bytes) == pinned_attachments[index]['sha256']
    end

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

  def self.addresses(value, max:)
    return nil unless value.is_a?(Array) && value.size <= max

    normalized = value.map { |candidate| mailbox(candidate) }
    return nil if normalized.any?(&:nil?) || normalized.uniq.size != normalized.size

    normalized
  end

  def self.attachment_metadata(value)
    return nil unless value.is_a?(Array) && value.size <= 2

    normalized = value.map do |entry|
      return nil unless entry.is_a?(Hash) && entry.keys.map(&:to_s).sort == %w[mime name sha256 size]

      item = entry.with_indifferent_access
      name = item[:name]
      mime = item[:mime]
      size = item[:size]
      sha256 = item[:sha256]
      return nil unless name.is_a?(String) && name.length.between?(1, 120) && !name.match?(%r{[\\/\x00-\x1f\x7f]})
      return nil unless mime == MIME_BY_EXTENSION[name.split('.').last.to_s.downcase]
      return nil unless size.is_a?(Integer) && size.between?(1, MAX_ATTACHMENT_BYTES)
      return nil unless sha256.is_a?(String) && sha256.match?(/\A[a-f0-9]{64}\z/)

      { 'name' => name, 'mime' => mime, 'size' => size, 'sha256' => sha256 }
    end
    return nil if normalized.sum { |item| item['size'] } > MAX_ATTACHMENT_BYTES * 2

    normalized
  end

  def self.attachment_bytes?(bytes, mime)
    return false unless bytes.is_a?(String) && bytes.bytesize.between?(9, MAX_ATTACHMENT_BYTES)

    case mime
    when 'image/png' then bytes.start_with?("\x89PNG\r\n\x1a\n".b)
    when 'image/jpeg' then bytes.start_with?("\xff\xd8\xff".b)
    when 'image/webp' then bytes.start_with?('RIFF') && bytes.byteslice(8, 4) == 'WEBP'
    when 'application/pdf'
      bytes.byteslice(0, 8).match?(/\A%PDF-[12]\.\d/) &&
        bytes.byteslice([bytes.bytesize - 1024, 0].max, 1024).match?(/%%EOF\s*\z/n)
    else false
    end
  end

  def self.safe_header?(value)
    !value.match?(/[\x00-\x1f\x7f]/)
  end

  def self.fail_context
    raise ArgumentError, 'Invalid native email reply context'
  end
end
