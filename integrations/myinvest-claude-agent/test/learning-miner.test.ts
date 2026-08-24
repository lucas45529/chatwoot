import { describe, expect, it } from 'vitest'
import {
  extractLiveCandidates,
  type LiveConversation,
  type LiveMessage,
} from '../src/learning/mine-conversations.js'
import { HANDED_OFF_DELIVERIES_SQL, LIVE_MESSAGES_SQL } from '../src/learning/live-queries.js'

const t0 = new Date('2026-08-20T10:00:00Z')

function message(partial: Partial<LiveMessage> & Pick<LiveMessage, 'messageId'>): LiveMessage {
  return {
    messageType: 0,
    senderType: 'Contact',
    private: false,
    content: 'Wie aktiviere ich die Maklerfreigabe in den Einstellungen?',
    createdAt: t0,
    ...partial,
  }
}

function conversation(partial: Partial<LiveConversation>): LiveConversation {
  return {
    conversationId: 42,
    handedOff: true,
    messages: [
      message({ messageId: 1 }),
      message({
        messageId: 2,
        messageType: 1,
        senderType: 'User',
        content: 'Die Maklerfreigabe aktivieren Sie unter Einstellungen, Bereich Team, dort den Haken bei Maklerfreigabe setzen.',
        createdAt: new Date(t0.getTime() + 60 * 60 * 1000),
      }),
    ],
    ...partial,
  }
}

function extract(conversations: LiveConversation[]) {
  return extractLiveCandidates({ tenant: 'saas', exportId: 'live-test', conversations })
}


describe('live mining SQL', () => {
  it('resolves account-scoped display IDs before joining internal message IDs', () => {
    expect(HANDED_OFF_DELIVERIES_SQL).toContain("status = 'handed_off'")
    expect(LIVE_MESSAGES_SQL).toContain('message.conversation_id = conversation.id')
    expect(LIVE_MESSAGES_SQL).toContain('conversation.account_id = $1')
    expect(LIVE_MESSAGES_SQL).toContain('conversation.display_id = ANY($2::bigint[])')
    expect(LIVE_MESSAGES_SQL).not.toContain('message.conversation_id = ANY')
  })
})
describe('live conversation mining', () => {
  it('turns a handed-off human answer into a reviewable candidate', () => {
    const result = extract([conversation({})])

    expect(result.examinedConversations).toBe(1)
    expect(result.candidates).toHaveLength(1)
    const candidate = result.candidates[0]!
    expect(candidate.status).toBe('pending_review')
    expect(candidate.targetTenant).toBe('saas')
    expect(candidate.sourceNamespace).toBe('chatwoot-live-v1')
    expect(candidate.questionRedacted).toContain('Maklerfreigabe')
    expect(candidate.answerRedacted).toContain('Einstellungen')
  })

  it('treats a WhatsApp external echo as a human-approved answer', () => {
    const result = extract([
      conversation({
        messages: [
          message({ messageId: 1 }),
          message({
            messageId: 2,
            messageType: 1,
            senderType: '',
            externalEcho: true,
            content:
              'Die Maklerfreigabe aktivieren Sie unter Einstellungen im Bereich Team.',
            createdAt: new Date(t0.getTime() + 60 * 1000),
          }),
        ],
      }),
    ])
    expect(result.candidates).toHaveLength(1)
  })

  it.each([
    ['Ist jemand hier?', 'Hallo, wie können wir helfen?'],
    [
      'Ich habe den Bankwechsel bestätigt und mir wurden zwei Leads versprochen.',
      'Wie heißt du und mit welcher E-Mail-Adresse bist du registriert?',
    ],
  ])('does not publish non-reusable or account-specific support text', (question, answer) => {
    const result = extract([
      conversation({
        messages: [
          message({ messageId: 1, content: question }),
          message({
            messageId: 2,
            messageType: 1,
            senderType: 'User',
            content: answer,
            createdAt: new Date(t0.getTime() + 60 * 1000),
          }),
        ],
      }),
    ])
    expect(result.candidates).toHaveLength(0)
  })

  it('skips clarification drafts but learns reviewed answers with a follow-up question', () => {
    const clarification = conversation({
      messages: [
        message({ messageId: 1, content: 'Mir fehlt noch die Zuordnung zu meinem Zugang.' }),
        message({
          messageId: 2,
          messageType: 1,
          senderType: 'AgentBot',
          private: true,
          agentKind: 'clarify_draft_note',
          content: 'KI-Entwurf zur Identitätsklärung.',
          createdAt: new Date(t0.getTime() + 30 * 1000),
        }),
        message({
          messageId: 3,
          messageType: 1,
          senderType: 'User',
          content: 'Wie lautet die registrierte E-Mail-Adresse?',
          createdAt: new Date(t0.getTime() + 60 * 1000),
        }),
      ],
    })
    expect(extract([clarification]).candidates).toHaveLength(0)

    const sourcedAnswer = conversation({
      messages: [
        message({ messageId: 11, content: 'Wo aktiviere ich die Maklerfreigabe?' }),
        message({
          messageId: 12,
          messageType: 1,
          senderType: 'AgentBot',
          private: true,
          agentKind: 'draft_note',
          content: 'KI-Entwurf mit freigegebener Quelle.',
          createdAt: new Date(t0.getTime() + 30 * 1000),
        }),
        message({
          messageId: 13,
          messageType: 1,
          senderType: 'User',
          content:
            'Die Maklerfreigabe aktivieren Sie unter Einstellungen im Bereich Team. Hat es geklappt?',
          createdAt: new Date(t0.getTime() + 60 * 1000),
        }),
      ],
    })
    expect(extract([sourcedAnswer]).candidates).toHaveLength(1)
  })

  it('learns every customer-to-human pair in one handed-off conversation', () => {
    const result = extract([
      conversation({
        messages: [
          message({ messageId: 1 }),
          message({
            messageId: 2,
            messageType: 1,
            senderType: 'User',
            content:
              'Die Maklerfreigabe aktivieren Sie unter Einstellungen im Bereich Team.',
            createdAt: new Date(t0.getTime() + 60 * 1000),
          }),
          message({
            messageId: 3,
            content: 'Wo sehe ich danach, ob die Freigabe wirklich aktiv ist?',
            createdAt: new Date(t0.getTime() + 2 * 60 * 1000),
          }),
          message({
            messageId: 4,
            messageType: 1,
            senderType: 'User',
            content:
              'Der aktive Status steht direkt in der Teamübersicht neben dem jeweiligen Benutzer.',
            createdAt: new Date(t0.getTime() + 3 * 60 * 1000),
          }),
        ],
      }),
    ])
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates.map((candidate) => candidate.sourcePairDigest)).toHaveLength(2)
  })

  it('skips conversations that were never handed off', () => {
    const result = extract([conversation({ handedOff: false })])

    expect(result.examinedConversations).toBe(0)
    expect(result.candidates).toHaveLength(0)
  })

  it('ignores bot answers and private notes — only humans teach', () => {
    const botOnly = conversation({
      messages: [
        message({ messageId: 1 }),
        message({
          messageId: 2,
          messageType: 1,
          senderType: 'AgentBot',
          content: 'Automatische Antwort des Bots mit ausreichend Laenge.',
          createdAt: new Date(t0.getTime() + 60 * 1000),
        }),
      ],
    })
    const noteOnly = conversation({
      messages: [
        message({ messageId: 1 }),
        message({
          messageId: 2,
          messageType: 1,
          senderType: 'User',
          private: true,
          content: 'Interne Notiz, keine Kundenantwort, darf nicht gelernt werden.',
          createdAt: new Date(t0.getTime() + 60 * 1000),
        }),
      ],
    })

    expect(extract([botOnly]).candidates).toHaveLength(0)
    expect(extract([noteOnly]).candidates).toHaveLength(0)
  })

  it('rejects sensitive topics instead of learning them', () => {
    const result = extract([
      conversation({
        messages: [
          message({ messageId: 1, content: 'Wie kann ich meinen Vertrag kündigen?' }),
          message({
            messageId: 2,
            messageType: 1,
            senderType: 'User',
            content: 'Die Kündigung senden Sie bitte schriftlich an unser Team, das wird dann geprüft.',
            createdAt: new Date(t0.getTime() + 60 * 1000),
          }),
        ],
      }),
    ])

    expect(result.candidates).toHaveLength(0)
    expect(result.rejectedConversations).toBe(1)
  })

  it('redacts phone numbers in mined answers', () => {
    const result = extract([
      conversation({
        messages: [
          message({ messageId: 1 }),
          message({
            messageId: 2,
            messageType: 1,
            senderType: 'User',
            content: 'Rufen Sie dazu einfach unter +49 171 2345678 an, wir richten die Maklerfreigabe dann gemeinsam ein.',
            createdAt: new Date(t0.getTime() + 60 * 1000),
          }),
        ],
      }),
    ])

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]!.answerRedacted).not.toContain('2345678')
    expect(result.candidates[0]!.redactionCount).toBeGreaterThan(0)
  })

  it('ignores answers that arrive more than 24 hours later', () => {
    const late = conversation({
      messages: [
        message({ messageId: 1 }),
        message({
          messageId: 2,
          messageType: 1,
          senderType: 'User',
          content: 'Diese Antwort kam viel zu spaet und gehoert nicht mehr zur urspruenglichen Frage.',
          createdAt: new Date(t0.getTime() + 48 * 60 * 60 * 1000),
        }),
      ],
    })

    expect(extract([late]).candidates).toHaveLength(0)
  })
})
