import { describe, expect, it, vi } from 'vitest'
import { automaticLearningCommandSchema, automaticLearningEvaluationSchema } from '../src/learning/automatic-schema.js'
import { assertAutomaticLearningEvaluation, automaticProposalHash } from '../src/learning/automatic-service.js'
import { LearningReviewService, learningCommandSchema } from '../src/learning/review-service.js'

const hash = 'a'.repeat(64)
const proposal = {
  question: 'Wie bearbeite ich einen Kontakt korrekt?',
  answer: 'Öffne den Kontakt und wähle anschließend Bearbeiten.',
  similarQuestion: 'Wo kann ich bestehende Kontakte ändern?',
  reason: 'Der Ablauf benennt den richtigen Einstieg.',
}
const score = { factualCorrectness: 3, contextCorrectness: 3, humanTone: 3, unsafe: false, criticalError: false }

describe('automatic learning contract', () => {
  it('accepts the exact signed claim/complete/status shapes and rejects unknown fields', () => {
    expect(learningCommandSchema.safeParse({ action: 'automatic', operation: 'claim', tenant: 'saas' }).success).toBe(true)
    expect(automaticLearningCommandSchema.safeParse({ action: 'automatic', operation: 'status', tenant: 'new_academy' }).success).toBe(true)
    expect(automaticLearningCommandSchema.safeParse({ action: 'automatic', operation: 'claim', tenant: 'saas', cursor: 1 }).success).toBe(false)
    expect(automaticLearningCommandSchema.safeParse({
      action: 'automatic', operation: 'complete', tenant: 'saas', id: '7', leaseId: crypto.randomUUID(),
      contentHash: hash, outcome: 'retry', reason: 'Zeitüberschreitung',
    }).success).toBe(true)
    expect(automaticLearningCommandSchema.safeParse({
      action: 'automatic', operation: 'complete', tenant: 'saas', id: '7', leaseId: crypto.randomUUID(),
      contentHash: hash, outcome: 'retry', reason: 'Zeitüberschreitung', proposal,
    }).success).toBe(false)
    expect(automaticLearningCommandSchema.safeParse({
      action: 'automatic', operation: 'complete', tenant: 'saas', id: '7', leaseId: crypto.randomUUID(),
      contentHash: hash, outcome: 'publish', reason: 'Geprüft',
    }).success).toBe(false)
  })

  it('binds the evaluation to a deterministic, field-delimited proposal hash', () => {
    expect(automaticProposalHash(proposal)).toMatch(/^[a-f0-9]{64}$/)
    expect(automaticProposalHash({ ...proposal, reason: proposal.reason + ' Neu.' })).not.toBe(automaticProposalHash(proposal))
  })

  it('requires a bounded four-pair evaluation without model response bodies', () => {
    const judgments = ['target', 'variant', 'heldout_benign', 'heldout_context_conflict'].map((pairId) => ({
      pairId, baseline: { ...score, factualCorrectness: 2 }, candidate: score, candidateWasA: true,
    }))
    const evaluation = {
      schemaVersion: 1, model: 'gemini-3.8-flash', promptVersion: 'automatic-learning-v1', brainVersion: 'local',
      sourceContentHash: hash, proposalHash: automaticProposalHash(proposal), passed: true,
      groundedProposal: true, judgments, rejectionReasons: [], pairHashes: Array(4).fill('c'.repeat(64)),
    }
    expect(automaticLearningEvaluationSchema.safeParse(evaluation).success).toBe(true)
    expect(automaticLearningEvaluationSchema.safeParse({ ...evaluation, groundedProposal: undefined }).success).toBe(false)
    expect(automaticLearningEvaluationSchema.safeParse({ ...evaluation, rawPairs: ['private output'] }).success).toBe(false)
    expect(() => assertAutomaticLearningEvaluation({ ...evaluation, groundedProposal: false }, proposal, hash))
      .toThrow('automatic_evaluation_not_grounded')
  })

  it('delegates automatic commands without opening a manual-review transaction', async () => {
    const connect = vi.fn()
    const execute = vi.fn().mockResolvedValue({ status: 'idle' })
    const service = new LearningReviewService({ connect }, undefined, { execute })
    await expect(service.execute({ action: 'automatic', operation: 'claim', tenant: 'saas' })).resolves.toEqual({ status: 'idle' })
    expect(execute).toHaveBeenCalledWith({ action: 'automatic', operation: 'claim', tenant: 'saas' })
    expect(connect).not.toHaveBeenCalled()
  })
})
