import type { DeliveryMessageKind } from './chatwoot-client.js'

interface QueryResult<Row> {
  rows: Row[]
}

interface Queryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

export interface ChatwootDeliveryStore {
  exists(input: {
    accountId: number
    conversationDisplayId: number
    deliveryId: number
    kind: DeliveryMessageKind
  }): Promise<boolean>
}

/**
 * Read-only Blick in Chatwoots messages-Tabelle. Der AgentBot darf Nachrichten
 * per API erstellen, aber Chatwoot 4.16.2 erlaubt Bots kein messages#index.
 * Dieser account- und conversation-gebundene Check macht POST-Retries trotzdem
 * idempotent, auch wenn Chatwoot die Nachricht vor einem HTTP-Timeout annahm.
 */
export class PostgresChatwootDeliveryStore implements ChatwootDeliveryStore {
  constructor(private readonly database: Queryable) {}

  async healthCheck(): Promise<void> {
    // Erzwingt echte SELECT-Rechte auf beiden Tabellen; `SELECT 1` allein
    // wuerde eine falsch konfigurierte Read-only-Rolle nicht erkennen.
    await this.database.query(
      'SELECT 1 FROM messages CROSS JOIN conversations WHERE false LIMIT 1',
    )
  }

  async exists(input: {
    accountId: number
    conversationDisplayId: number
    deliveryId: number
    kind: DeliveryMessageKind
  }): Promise<boolean> {
    const result = await this.database.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1
           FROM messages AS message
           JOIN conversations AS conversation
             ON conversation.id = message.conversation_id
            AND conversation.account_id = $1
          WHERE message.account_id = $1
            AND conversation.display_id = $2
            AND message.content_attributes ->> 'myinvest_agent_delivery_id' = $3
            AND message.content_attributes ->> 'myinvest_agent_message_kind' = $4
       ) AS exists`,
      [input.accountId, input.conversationDisplayId, String(input.deliveryId), input.kind],
    )
    return result.rows[0]?.exists === true
  }
}
