import { z } from 'zod'
import { tenantKeySchema } from '../domain.js'

const id = z.string().regex(/^[1-9]\d{0,18}$/)
const messageId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/)

export const automaticLearningSourceIdsSchema = z.object({
  accountId: messageId,
  inboxId: messageId,
  conversationId: messageId,
  questionMessageId: messageId,
  draftMessageId: messageId,
  answerMessageId: messageId,
}).strict()

export const automaticLearningProposalSchema = z.object({
  question: z.string().trim().min(8).max(1000),
  answer: z.string().trim().min(10).max(4000),
  similarQuestion: z.string().trim().min(8).max(1000),
  reason: z.string().trim().min(3).max(1000),
}).strict()

const answerJudgmentSchema = z.object({
  factualCorrectness: z.number().int().min(0).max(4),
  contextCorrectness: z.number().int().min(0).max(4),
  humanTone: z.number().int().min(0).max(4),
  unsafe: z.boolean(),
  criticalError: z.boolean(),
}).strict()

const pairIdSchema = z.enum(['target', 'variant', 'heldout_benign', 'heldout_context_conflict'])
export const automaticLearningEvaluationSchema = z.object({
  schemaVersion: z.literal(1),
  model: z.string().trim().min(1).max(200),
  promptVersion: z.string().trim().min(1).max(200),
  brainVersion: z.string().trim().min(1).max(200),
  sourceContentHash: hash,
  proposalHash: hash,
  passed: z.boolean(),
  groundedProposal: z.boolean(),
  judgments: z.array(z.object({
    pairId: pairIdSchema,
    baseline: answerJudgmentSchema,
    candidate: answerJudgmentSchema,
    candidateWasA: z.boolean(),
  }).strict()).length(4),
  rejectionReasons: z.array(z.enum([
    'candidate_safety_error',
    'candidate_critical_error',
    'candidate_quality_floor',
    'score_regression',
    'target_not_improved',
    'variant_not_improved',
    'proposal_not_grounded',
  ])).max(7),
  pairHashes: z.array(hash).length(4),
}).strict()

const claim = z.object({
  action: z.literal('automatic'), operation: z.literal('claim'), tenant: tenantKeySchema,
}).strict()
const status = z.object({
  action: z.literal('automatic'), operation: z.literal('status'), tenant: tenantKeySchema,
}).strict()
const completionBinding = {
  action: z.literal('automatic'), operation: z.literal('complete'), tenant: tenantKeySchema,
  id, leaseId: z.string().uuid(), contentHash: hash, reason: z.string().trim().min(1).max(500),
}
const complete = z.discriminatedUnion('outcome', [
  z.object({ ...completionBinding, outcome: z.literal('publish'), proposal: automaticLearningProposalSchema,
    evaluation: automaticLearningEvaluationSchema.extend({ passed: z.literal(true) }) }).strict(),
  z.object({ ...completionBinding, outcome: z.literal('reject'), proposal: automaticLearningProposalSchema.optional(),
    evaluation: automaticLearningEvaluationSchema.optional() }).strict(),
  z.object({ ...completionBinding, outcome: z.literal('retry') }).strict(),
])

export const automaticLearningCommandSchemas = [claim, status, ...complete.options] as const
export const automaticLearningCommandSchema = z.union([claim, status, complete])
export type AutomaticLearningCommand = z.infer<typeof automaticLearningCommandSchema>
export type AutomaticLearningProposal = z.infer<typeof automaticLearningProposalSchema>
export type AutomaticLearningEvaluation = z.infer<typeof automaticLearningEvaluationSchema>
export type AutomaticLearningSourceIds = z.infer<typeof automaticLearningSourceIdsSchema>
