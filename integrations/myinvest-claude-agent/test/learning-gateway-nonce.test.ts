import { describe, expect, it, vi } from 'vitest'
import { claimLearningGatewayNonce } from '../src/learning/gateway-nonce.js'
const key = 'support-learning:v1:00000000-0000-4000-8000-000000000001'
describe('durable learning request nonce', () => {
  it('claims only from a parameter-bound atomic database result', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ claimed: true }] }).mockResolvedValueOnce({ rows: [] })
    expect(await claimLearningGatewayNonce({ query }, key, 601)).toBe(true)
    expect(await claimLearningGatewayNonce({ query }, key, 601)).toBe(false)
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'), [key, 601])
    expect(query.mock.calls[0]![0]).not.toContain(key)
  })
  it.each([['other-prefix', 601], [key, 602], [key, 0], [key, 1.1]])('refuses invalid nonce input %s/%s before database access', async (value, ttl) => {
    const query = vi.fn()
    await expect(claimLearningGatewayNonce({ query }, String(value), Number(ttl))).rejects.toThrow('learning_nonce_invalid')
    expect(query).not.toHaveBeenCalled()
  })
})
