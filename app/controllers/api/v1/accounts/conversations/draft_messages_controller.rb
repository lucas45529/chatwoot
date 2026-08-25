class Api::V1::Accounts::Conversations::DraftMessagesController < Api::V1::Accounts::Conversations::BaseController
  def show
    render json: { has_draft: false } and return unless Redis::Alfred.exists?(draft_redis_key)

    draft_message = Redis::Alfred.get(draft_redis_key)
    render json: { has_draft: true, message: draft_message }
  end

  def update
    payload = params.fetch(:draft_message, {})
    written =
      if payload[:expected_absent]
        Redis::Alfred.set(draft_redis_key, draft_message_params, nx: true)
      elsif payload.key?(:expected_message)
        Redis::Alfred.set_if_equals(
          draft_redis_key,
          payload[:expected_message],
          draft_message_params
        )
      else
        Redis::Alfred.set(draft_redis_key, draft_message_params)
      end

    return head :conflict unless written

    head :ok
  end

  def destroy
    Redis::Alfred.delete(draft_redis_key)
    head :ok
  end

  private

  def draft_redis_key
    format(Redis::Alfred::CONVERSATION_DRAFT_MESSAGE, id: @conversation.id)
  end

  def draft_message_params
    params.dig(:draft_message, :message) || ''
  end
end
