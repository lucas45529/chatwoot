interface Queryable {
  query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }>
}

/** A shared durable claim survives restarts and simultaneous gateway instances. */
export async function claimLearningGatewayNonce(database: Queryable, key: string, ttlSeconds: number): Promise<boolean> {
  if (!/^support-learning:v1:[0-9a-f-]{36}$/.test(key) || !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 601)
    throw new Error('learning_nonce_invalid')
  const result = await database.query<{ claimed: boolean }>(`
    INSERT INTO agent_learning_request_nonces (request_key, expires_at)
    VALUES ($1, clock_timestamp() + make_interval(secs => $2))
    ON CONFLICT (request_key) DO UPDATE SET expires_at = EXCLUDED.expires_at
      WHERE agent_learning_request_nonces.expires_at <= clock_timestamp()
    RETURNING true AS claimed`, [key, ttlSeconds])
  return result.rows[0]?.claimed === true
}
