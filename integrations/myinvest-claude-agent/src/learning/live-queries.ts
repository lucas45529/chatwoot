export const HANDED_OFF_DELIVERIES_SQL = `SELECT DISTINCT tenant_key, conversation_id::text
       FROM agent_delivery_ledger
      WHERE status = 'handed_off'
        AND conversation_id > 0
        AND updated_at >= now() - ($1 || ' days')::interval
        AND ($2::text IS NULL OR tenant_key = $2)`

// conversation_id in the agent ledger is Chatwoots account-scoped display_id.
// Resolve it through conversations before joining messages.conversation_id,
// which is Chatwoots global internal id.
export const LIVE_MESSAGES_SQL = `SELECT conversation.display_id::text AS conversation_display_id,
              message.id::text AS message_id, message.message_type,
              message.sender_type, message.private, message.content, message.created_at,
              message.content_attributes ->> 'myinvest_agent_message_kind' AS agent_kind,
              (message.content_attributes ->> 'external_echo') IS NOT NULL AS external_echo,
              (message.content_attributes ->> 'automation_rule_id') IS NOT NULL AS from_automation,
              (message.additional_attributes ? 'campaign_id') AS from_campaign
         FROM conversations AS conversation
         JOIN messages AS message
           ON message.conversation_id = conversation.id
          AND message.account_id = conversation.account_id
        WHERE conversation.account_id = $1
          AND conversation.display_id = ANY($2::bigint[])
          AND message.content IS NOT NULL
          AND message.content <> ''
        ORDER BY conversation.display_id, message.created_at ASC, message.id ASC`
