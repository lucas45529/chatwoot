import express from 'express'
import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import pg from 'pg'
import {
  PostgresAutoSendLog,
  PostgresConversationProcessingLock,
} from './auto-send-repository.js'
import { ChatwootClient } from './chatwoot-client.js'
import { PostgresChatwootDeliveryStore } from './chatwoot-delivery-repository.js'
import { loadConfig } from './config.js'
import { InternSsoError, InternSsoService } from './intern-sso.js'
import { runAutoSendFeedbackSweep } from './learning/auto-send-feedback.js'
import { MessageProcessor } from './processor.js'
import { DeliveryQueue, QUEUE_NAME, type DeliveryJob } from './queue.js'
import { PostgresAgentState } from './state.js'
import { SupportBrainClient, type SupportBrainPort } from './support-brain.js'
import { WebhookController } from './webhook/controller.js'
import { webhookHttpError } from './webhook/http-error.js'

const config = loadConfig()
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null })
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 })
const chatwootPool = new pg.Pool({ connectionString: config.CHATWOOT_DATABASE_URL, max: 4 })
const deliveryStore = new PostgresChatwootDeliveryStore(
  chatwootPool,
  config.PSEUDONYMIZATION_KEY,
)
await deliveryStore.healthCheck()
const queue = new Queue<DeliveryJob>(QUEUE_NAME, { connection: redis })
const deliveryQueue = new DeliveryQueue(queue, {
  retentionSeconds: config.DELIVERY_RETENTION_SECONDS,
})
const state = new PostgresAgentState(pool)
const autoSendLog = new PostgresAutoSendLog(pool)
const conversationLock = new PostgresConversationProcessingLock(pool)
const brain: SupportBrainPort = config.LOCAL_FAKE_BRAIN_ANSWER
  ? {
      async answer() {
        return {
          action: 'answer',
          text: config.LOCAL_FAKE_BRAIN_ANSWER as string,
          confidence: 0.9,
          sources: [{ title: 'Lokaler Smoke', url: 'https://local.invalid/smoke' }],
          safeToAutoSend: true,
        }
      },
    }
  : new SupportBrainClient({
      baseUrl: config.SUPPORT_ANSWER_URL,
      secret: config.SUPPORT_ANSWER_SECRET,
      timeoutMs: config.SUPPORT_ANSWER_TIMEOUT_MS,
    })
const processor = new MessageProcessor({
  brain,
  chatwoot: new ChatwootClient(config.CHATWOOT_BASE_URL, deliveryStore),
  context: deliveryStore,
  state,
  autoSend: autoSendLog,
  autoSendEnabled: config.AUTO_SEND_ENABLED,
  autoSendLimits: {
    maxPerConversation: config.AUTO_SEND_MAX_PER_CONVERSATION,
    maxPerContactPerHour: config.AUTO_SEND_MAX_PER_CONTACT_PER_HOUR,
  },
  conversationLock,
  pseudonymizationKey: config.PSEUDONYMIZATION_KEY,
  whatsappInboxIds: config.whatsappInboxIds,
})
const controller = new WebhookController({
  tenants: config.tenants,
  queue: deliveryQueue,
  replayWindowSeconds: config.WEBHOOK_REPLAY_WINDOW_SECONDS,
})
const internSso = new InternSsoService(
  {
    secret: config.SUPPORT_CHATWOOT_SSO_SECRET,
    audience: config.INTERN_SSO_AUDIENCE,
    email: config.INTERN_SSO_EMAIL,
    password: config.INTERN_SSO_PASSWORD,
    returnPath: config.INTERN_SSO_RETURN_PATH,
    chatwootBaseUrl: config.CHATWOOT_BASE_URL,
  },
  redis,
)

const worker =
  config.RUN_MODE === 'web'
    ? undefined
    : new Worker<DeliveryJob>(
        QUEUE_NAME,
        async (job) => {
          const tenant = config.tenants.requireByKey(job.data.tenantKey)
          const maxAttempts = job.opts.attempts ?? 1
          try {
            await processor.process({
              tenant,
              payload: job.data.payload,
              isFinalAttempt: job.attemptsMade + 1 >= maxAttempts,
            })
          } catch (error) {
            try {
              await state.failDelivery(tenant.key, job.data.payload.id)
            } catch (stateError) {
              console.error(
                'Agent delivery failure could not be persisted',
                job.id,
                stateError instanceof Error ? stateError.message : String(stateError),
              )
            }
            throw error
          }
        },
        { connection: redis.duplicate(), concurrency: 4 },
      )

worker?.on('failed', (job, error) =>
  console.error('Agent job failed', job?.id, error.message),
)

// Nur die Worker-Rolle wertet Auto-Antworten nach. Ueberlappende Laeufe sind
// ausgeschlossen, damit ein langsamer Durchlauf keinen zweiten startet.
let feedbackSweepRunning = false
const feedbackTimer = worker
  ? setInterval(() => {
      if (feedbackSweepRunning) return
      feedbackSweepRunning = true
      void runAutoSendFeedbackSweep({ agentPool: pool, chatwootPool, tenants: config.tenants })
        .then((result) => {
          if (result.evaluated > 0) {
            console.log(JSON.stringify({ event: 'agent_auto_send_feedback_sweep', ...result }))
          }
        })
        .catch((error: unknown) =>
          console.error(
            'Auto-send feedback sweep failed',
            error instanceof Error ? error.message : String(error),
          ),
        )
        .finally(() => {
          feedbackSweepRunning = false
        })
    }, config.AUTO_SEND_FEEDBACK_INTERVAL_SECONDS * 1_000)
  : undefined
feedbackTimer?.unref()

const app = express()
app.get('/health', async (_request, response) => {
  try {
    await Promise.all([pool.query('SELECT 1'), deliveryStore.healthCheck(), redis.ping()])
    response.json({ status: 'ok' })
  } catch {
    response.status(503).json({ status: 'unavailable' })
  }
})

app.post(
  '/sso',
  express.urlencoded({ extended: false, limit: '4kb' }),
  async (request, response) => {
    const token = typeof request.body?.token === 'string' ? request.body.token : ''
    try {
      const session = await internSso.createSession(token)
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Referrer-Policy', 'no-referrer')
      response.setHeader('Set-Cookie', session.cookie)
      return response.redirect(303, session.location)
    } catch (error) {
      const status = error instanceof InternSsoError ? error.status : 503
      return response.status(status).json({ error: 'support login unavailable' })
    }
  },
)

app.post(
  '/webhooks/chatwoot',
  express.raw({ type: 'application/json', limit: config.MAX_BODY_BYTES }),
  async (request, response) => {
    if (!Buffer.isBuffer(request.body)) {
      return response.status(415).json({ error: 'application/json required' })
    }
    try {
      const result = await controller.handle(request.body.toString('utf8'), request.headers)
      return response.status(result.status).json(result.body)
    } catch (error) {
      const rejection = webhookHttpError(error)
      if (rejection.log) {
        console.error('Webhook rejected', error instanceof Error ? error.message : 'unknown error')
      }
      return response.status(rejection.status).json(rejection.body)
    }
  },
)

const server =
  config.RUN_MODE === 'worker'
    ? undefined
    : app.listen(config.PORT, '0.0.0.0', () =>
        console.log(`Claude agent listening on ${config.PORT}`),
      )

async function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down`)
  clearInterval(feedbackTimer)
  server?.close()
  await worker?.close()
  await queue.close()
  await redis.quit()
  await pool.end()
  await chatwootPool.end()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
