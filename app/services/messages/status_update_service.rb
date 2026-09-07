class Messages::StatusUpdateService
  DELIVERY_STATUS_RANK = {
    'sent' => 0,
    'delivered' => 1,
    'read' => 2
  }.freeze

  attr_reader :message, :status, :external_error

  def initialize(message, status, external_error = nil)
    @message = message
    @status = status
    @external_error = external_error
  end

  def perform
    message.with_lock do
      next false unless valid_status_transition?

      update_message_status
    end
  end

  private

  def update_message_status
    # Update status and set external_error only when failed
    message.update!(
      status: status,
      external_error: (status == 'failed' ? external_error : nil)
    )
  end

  def valid_status_transition?
    return false unless Message.statuses.key?(status)

    current_rank = DELIVERY_STATUS_RANK[message.status]
    requested_rank = DELIVERY_STATUS_RANK[status]
    return false if current_rank && requested_rank && requested_rank < current_rank

    true
  end
end
