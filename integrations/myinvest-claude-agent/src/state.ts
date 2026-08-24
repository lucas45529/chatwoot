import type { TenantKey } from './domain.js'

export type DeliveryStatus = 'processing' | 'sending' | 'replied' | 'handed_off'
export interface DeliveryClaim {
  status: DeliveryStatus
  acquired: boolean
}

interface QueryResult<Row> {
  rows: Row[]
}

interface Queryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

export interface AgentState {
  isHandedOff(tenantKey: TenantKey, conversationId: number): Promise<boolean>
  activateConversation(tenantKey: TenantKey, conversationId: number): Promise<void>
  beginDelivery(
    tenantKey: TenantKey,
    messageId: number,
    conversationId: number,
  ): Promise<DeliveryClaim>
  markSending(tenantKey: TenantKey, messageId: number): Promise<void>
  completeReply(tenantKey: TenantKey, messageId: number): Promise<void>
  completeHandoff(
    tenantKey: TenantKey,
    messageId: number,
    conversationId: number,
  ): Promise<void>
  failDelivery(tenantKey: TenantKey, messageId: number): Promise<void>
}

export class PostgresAgentState implements AgentState {
  constructor(private readonly database: Queryable) {}

  async isHandedOff(tenantKey: TenantKey, conversationId: number): Promise<boolean> {
    const result = await this.database.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM agent_conversation_states
          WHERE tenant_key = $1 AND conversation_id = $2 AND status = 'handed_off'
       ) AS exists`,
      [tenantKey, conversationId],
    )
    return result.rows[0]?.exists === true
  }

  async activateConversation(tenantKey: TenantKey, conversationId: number): Promise<void> {
    await this.database.query(
      `UPDATE agent_conversation_states
          SET status = 'active', updated_at = now()
        WHERE tenant_key = $1 AND conversation_id = $2 AND status = 'handed_off'`,
      [tenantKey, conversationId],
    )
  }

  /**
   * Claim je (tenant, message). Neu erworben wird nur eine freie Zeile, der
   * Retry-Sentinel (negative conversation_id) oder ein Lease, dessen Besitzer
   * seit fuenf Minuten nichts mehr geschrieben hat. Alles andere gehoert einem
   * anderen Worker oder ist terminal.
   */
  async beginDelivery(
    tenantKey: TenantKey,
    messageId: number,
    conversationId: number,
  ): Promise<DeliveryClaim> {
    const result = await this.database.query<{ status: DeliveryStatus; acquired: boolean }>(
      `WITH claimed AS (
         INSERT INTO agent_delivery_ledger (tenant_key, message_id, conversation_id, status)
         VALUES ($1, $2, $3, 'processing')
         ON CONFLICT (tenant_key, message_id) DO UPDATE
           SET conversation_id = EXCLUDED.conversation_id,
               status = 'processing',
               updated_at = now()
         WHERE agent_delivery_ledger.conversation_id < 0
            OR (
              agent_delivery_ledger.status IN ('processing', 'sending')
              AND agent_delivery_ledger.updated_at < now() - interval '5 minutes'
            )
         RETURNING status, true AS acquired
       )
       SELECT status, acquired FROM claimed
       UNION ALL
       SELECT status, false AS acquired
         FROM agent_delivery_ledger
        WHERE tenant_key = $1 AND message_id = $2
       LIMIT 1`,
      [tenantKey, messageId, conversationId],
    )
    const claim = result.rows[0]
    if (!claim) throw new Error('Delivery ledger did not return a claim')
    return claim
  }

  async markSending(tenantKey: TenantKey, messageId: number): Promise<void> {
    const result = await this.database.query<{ updated: number }>(
      `UPDATE agent_delivery_ledger
          SET status = 'sending', updated_at = now()
        WHERE tenant_key = $1 AND message_id = $2 AND status = 'processing'
        RETURNING 1 AS updated`,
      [tenantKey, messageId],
    )
    if (!result.rows[0]) throw new Error('Delivery could not enter sending state')
  }

  async completeReply(tenantKey: TenantKey, messageId: number): Promise<void> {
    const result = await this.database.query<{ updated: number }>(
      `UPDATE agent_delivery_ledger
          SET status = 'replied', updated_at = now()
        WHERE tenant_key = $1 AND message_id = $2 AND status = 'sending'
        RETURNING 1 AS updated`,
      [tenantKey, messageId],
    )
    if (!result.rows[0]) throw new Error('Delivery could not complete as replied')
  }

  /** Conversation-state und Delivery-Ledger muessen atomar terminal werden. */
  async completeHandoff(
    tenantKey: TenantKey,
    messageId: number,
    conversationId: number,
  ): Promise<void> {
    const result = await this.database.query<{ completed: number }>(
      `WITH completed AS (
         UPDATE agent_delivery_ledger
            SET status = 'handed_off', updated_at = now()
          WHERE tenant_key = $1 AND message_id = $2
            AND status = 'processing'
         RETURNING 1
       )
       INSERT INTO agent_conversation_states (tenant_key, conversation_id, status)
       SELECT $1, $3, 'handed_off' FROM completed
       ON CONFLICT (tenant_key, conversation_id) DO UPDATE
         SET status = 'handed_off', updated_at = now()
       RETURNING 1 AS completed`,
      [tenantKey, messageId, conversationId],
    )
    if (!result.rows[0]) throw new Error('Delivery and conversation could not complete handoff')
  }

  /**
   * Negative conversation_id ist der bestehende, schemafreie Retry-Sentinel.
   * Der naechste BullMQ-Versuch kann genau diese nicht-terminale Zeile claimen.
   */
  async failDelivery(tenantKey: TenantKey, messageId: number): Promise<void> {
    const result = await this.database.query<{ updated: number }>(
      `UPDATE agent_delivery_ledger
          SET conversation_id = -ABS(conversation_id),
              status = 'processing',
              updated_at = now()
        WHERE tenant_key = $1 AND message_id = $2
          AND status IN ('processing', 'sending')
        RETURNING 1 AS updated`,
      [tenantKey, messageId],
    )
    if (!result.rows[0]) throw new Error('Delivery could not be re-armed for retry')
  }
}
