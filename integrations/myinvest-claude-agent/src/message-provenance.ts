/** Chatwoot stores some MyInvest-generated outbound messages with a User sender.
 * Only server-originated markers or explicitly bot-authored imports may bypass
 * the permanent human takeover gate. */
export function messageAttributesSql(alias: string): string {
  return `CASE WHEN json_typeof(${alias}.content_attributes) = 'string'
               THEN (${alias}.content_attributes #>> '{}')::json
               ELSE ${alias}.content_attributes END`
}

export function myinvestAutomatedOutboundSql(alias: string): string {
  const attrs = messageAttributesSql(alias)
  return `(COALESCE(${alias}.source_id LIKE 'mip:wa:%:sys:%', false)
           OR COALESCE(${alias}.source_id LIKE 'mip:wa:%:out:%', false)
           OR (${attrs} ->> 'myinvest_outbound_id' IS NOT NULL
               AND ${attrs} ->> 'myinvest_outbound_kind' IS NOT NULL)
           OR ((COALESCE(${alias}.source_id LIKE 'mip:history:%', false)
                 OR COALESCE(${alias}.source_id LIKE 'mip:web:saas:%', false))
               AND ${attrs} ->> 'myinvest_history_author' = 'bot'))`
}
