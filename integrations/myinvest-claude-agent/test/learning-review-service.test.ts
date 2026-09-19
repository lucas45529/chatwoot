import { describe, expect, it, vi } from 'vitest'
import { LearningReviewService, matchReviewedExamples } from '../src/learning/review-service.js'

function fixture(status = 'published', tenant = 'saas') {
  return { id: '9', tenant, question: 'Wie bearbeite ich Kontakte?', answer: 'Öffne Kontakte und wähle Bearbeiten.', status, reason: '', updatedAt: '2026-09-05T08:00:00Z', published_document_id: '81', reviewed_by: 'chatwoot-human-send' }
}

function database(row = fixture()) {
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (sql.includes('FOR UPDATE')) return { rows: values?.[1] === row.tenant ? [row] : [] }
    if (sql.includes('INSERT INTO agent_knowledge_candidates')) return { rows: [{ id: '10' }] }
    if (sql.includes('FROM agent_knowledge_candidates')) return { rows: [{ ...row, id: '10', status: 'pending_review' }] }
    return { rows: [] }
  })
  return { query, service: new LearningReviewService({ connect: async () => ({ query, release: vi.fn() }) }) }
}

describe('existing learning candidate review', () => {
  it('shows automatic historical publications as awaiting explicit review', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM agent_knowledge_candidates') ? [fixture(), { ...fixture(), id: '11', reviewed_by: 'intern-support-review' }] : [] }))
    const service = new LearningReviewService({ connect: async () => ({ query, release: vi.fn() }) })
    await expect(service.execute({ action: 'list', tenant: 'saas' })).resolves.toMatchObject({ candidates: [
      { id: '9', status: 'pending_review' }, { id: '11', status: 'published' },
    ] })
  })

  it('cannot edit or publish a candidate through another tenant', async () => {
    const { service, query } = database()
    await expect(service.execute({ action: 'publish', tenant: 'new_academy', id: '9' }))
      .rejects.toMatchObject({ status: 404 })
    expect(query.mock.calls.some(([sql]) => /^(UPDATE|INSERT)/.test(sql))).toBe(false)
  })

  it('retires a published version and creates a pending replacement on correction', async () => {
    const { service, query } = database()
    await service.execute({ action: 'save', tenant: 'saas', id: '9', question: 'Wie bearbeite ich Kontakte?', answer: 'Öffne Kontakte und wähle den Namen.', reason: 'Der bisherige Knopf existiert nicht mehr.' })
    const sql = query.mock.calls.map(([statement]) => statement).join('\n')
    expect(sql).toContain("status = 'rejected'")
    expect(sql).toContain("publication_status = 'retired'")
    expect(sql).toContain('INSERT INTO agent_knowledge_candidates')
    expect(sql).not.toContain('INSERT INTO agent_knowledge_documents')
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT')
  })

  it('rejects credentials rather than persisting them', async () => {
    const { service, query } = database()
    await expect(service.execute({ action: 'save', tenant: 'saas', question: 'Welcher Zugang?', answer: 'Nutze sk-abcdefghijklmnopqrstuv.', reason: 'Korrektur' })).rejects.toMatchObject({ status: 422 })
    expect(query).not.toHaveBeenCalled()
  })

  it.each([
    'Für Max Mustermann sind zwei zusätzliche Leads freigegeben. Sein persönliches Passwort lautet Sommerregen2026!.',
    'Sein persönliches Kennwort ist Sommerregen2026!.',
    'Für Max Mustermann sind zwei zusätzliche Leads freigegeben.',
    'Dir wurden fünf Leads zugesagt und zwei weitere freigegeben.',
    'Bitte das Passwort zurücksetzen auf Sommerregen2026! und anschließend anmelden.',
    'Bitte das Kennwort ändern zu Sonnenschein und anschließend anmelden.',
    'Das Passwort zurücksetzen = Sommerregen2026!.',
    'Bitte auf „Passwort zurücksetzen“ klicken und das Passwort auf Sonnenschein setzen.',
    'Your personal password is SummerRain2026!; use it to sign in.',
    'Deine persönliche PIN lautet 4682. Damit kannst du dich anmelden.',
    'Your passcode is 4682. Enter it to sign in.',
    'Your access code is 4682 and your recovery code is abcd-efgh.',
    'Dein Wiederherstellungscode lautet abcd-efgh.',
    'Your API key is SummerRain2026! Use it for the integration.',
    'Setze den API-Schlüssel auf Sommerregen2026! für die Integration.',
  ])('rejects personal credentials and individual promises in both save and publish: %s', async (answer) => {
    const save = database()
    await expect(save.service.execute({ action: 'save', tenant: 'saas', question: 'Wie funktioniert der Zugang?', answer, reason: 'Bessere Antwort' })).rejects.toMatchObject({ status: 422 })
    expect(save.query).not.toHaveBeenCalled()
    const publish = database({ ...fixture('pending_review'), answer })
    await expect(publish.service.execute({ action: 'publish', tenant: 'saas', id: '9' })).rejects.toMatchObject({ status: 422 })
    expect(publish.query.mock.calls.some(([sql]) => /^(INSERT|UPDATE)/.test(sql))).toBe(false)
  })

  it('allows generic password reset process advice without a credential or individual promise', async () => {
    const { service } = database()
    await expect(service.execute({ action: 'save', tenant: 'saas', question: 'Wie kann ich mein Passwort zurücksetzen?', answer: 'Klicke im Anmeldefenster auf Passwort vergessen und folge den Hinweisen.', reason: 'Den allgemeinen Ablauf erklären.' })).resolves.toHaveProperty('candidate')
  })

  it.each([
    'Klicke im Anmeldefenster auf „Passwort zurücksetzen“.',
    'Wähle den Button "Passwort vergessen" und folge den Hinweisen.',
    'Klicke auf Passwort zurücksetzen.',
  ])('allows a generic reset navigation instruction: %s', async (answer) => {
    await expect(database().service.execute({ action: 'save', tenant: 'saas', question: 'Wie kann ich mein Passwort zurücksetzen?', answer, reason: 'Allgemeinen Ablauf erklären.' })).resolves.toHaveProperty('candidate')
  })

  it('versions pending edits too, so an older review tab cannot approve new text', async () => {
    const { service, query } = database(fixture('pending_review'))
    await service.execute({ action: 'save', tenant: 'saas', id: '9', question: 'Wie bearbeite ich Kontakte?', answer: 'Öffne Kontakte und wähle den Namen.', reason: 'Besserer Ablauf' })
    expect(query.mock.calls.some(([sql]) => sql.includes("status = 'rejected'"))).toBe(true)
    expect(query.mock.calls.some(([sql]) => sql.includes('SET question_redacted'))).toBe(false)
    const stale = database(fixture('rejected'))
    await expect(stale.service.execute({ action: 'publish', tenant: 'saas', id: '9' })).rejects.toMatchObject({ status: 409 })
    expect(stale.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO agent_knowledge_documents'))).toBe(false)
  })

  it('retrieval includes explicit publication provenance, active document and tenant filters', async () => {
    const { service, query } = database()
    await service.execute({ action: 'retrieve', tenant: 'saas', question: 'Wie bearbeite ich Kontakte?' })
    const sql = query.mock.calls.map(([statement]) => statement).join('\n')
    expect(sql).toContain("c.reviewed_by = 'intern-support-review'")
    expect(sql).toContain("a.actor = 'intern-support-review'")
    expect(sql).toContain("d.active = true")
    expect(sql).toContain('c.target_tenant = $1')
  })

  it('requires specific matching terms and returns at most three reviewed examples', () => {
    expect(matchReviewedExamples('Wie kann ich das machen?', [fixture()])).toEqual([])
    expect(matchReviewedExamples('Wie bearbeite ich Kontakte?', Array.from({ length: 5 }, (_, i) => ({ ...fixture(), id: String(i) })))).toHaveLength(3)
    expect(matchReviewedExamples('Wie bearbeite ich Immobilien?', [fixture()])).toEqual([])
  })
})

describe('conversation-situation retrieval', () => {
  it('matches a specific reviewed situation inside longer relevant context', () => {
    const row = { ...fixture(), question: 'Termin bereits bestätigt Zoom Link vorhanden Telefonnummer erhalten' }
    expect(matchReviewedExamples('Gespräch: Du hast eine Terminbestätigung erhalten. Termin bereits bestätigt Zoom Link vorhanden. Kunde sendet Telefonnummer erhalten und bedankt sich. Aktuell: Danke, passt für mich!', [row])).toHaveLength(1)
    expect(matchReviewedExamples('Telefonnummer erhalten', [row])).toEqual([])
    expect(matchReviewedExamples('Termin absagen Zoom Link funktioniert nicht', [row])).toEqual([])
  })
  it('uses identical eligibility and approved retrieval for a read-only preview', async () => {
    const { service, query } = database()
    await expect(service.execute({ action: 'preview', tenant: 'saas', question: 'Wie bearbeite ich Kontakte?', example: { question: 'Wie bearbeite ich Kontakte?', answer: 'Öffne Kontakte und wähle Bearbeiten.', reason: 'Genauer Ablauf' } })).resolves.toMatchObject({ candidateMatches: true })
    expect(query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false)
  })
})


it('keeps the corrected message only as redacted audit metadata', async () => {
  const { service, query } = database()
  await service.execute({ action: 'save', tenant: 'saas', question: 'Wie bearbeite ich Kontakte?', answer: 'Öffne Kontakte und wähle Bearbeiten.', reason: 'Korrigierter Ablauf', correctedAnswer: 'Nutze den Kontakt kunde@example.de und wähle Bearbeiten.' })
  const event = query.mock.calls.find(([sql, values]) => sql.includes('INSERT INTO agent_learning_audit_events') && values?.[2] === 'feedback_recorded')
  expect(event?.[1]?.[4]).toMatchObject({ correctedAnswer: 'Nutze den Kontakt [E-MAIL/ACCOUNT] und wähle Bearbeiten.' })
  const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO agent_knowledge_candidates'))
  expect(insert?.[1]).not.toContain('Nutze den Kontakt kunde@example.de und wähle Bearbeiten.')
})

it('recognizes equivalent appointment language without matching absent appointments', () => {
  const row = { ...fixture(), question: 'Kunde nennt seine Telefonnummer, obwohl bereits ein Termin per Zoom vereinbart ist.' }
  expect(matchReviewedExamples('Hi, das wäre meine Rufnummer [TELEFON]. Gesprächskontext: Hey Alex, dein Call am Montag 21. September um 14:00 Uhr ist bestätigt. Zoom-Link ist dabei.', [row])).toHaveLength(1)
  expect(matchReviewedExamples('Hier ist meine Rufnummer [TELEFON]. Ich habe keinen Termin vereinbart und möchte einen Rückruf.', [row])).toEqual([])
  expect(matchReviewedExamples('Hier ist meine Telefonnummer, wann kann ich einen Termin buchen?', [row])).toEqual([])
})

it('returns the sanitized preview candidate used for matching', async () => {
  const { service } = database()
  await expect(service.execute({ action: 'preview', tenant: 'saas', question: 'Wie bearbeite ich Kontakte?', example: { question: 'Wie bearbeite ich Kontakte?', answer: 'Öffne den Kontakt kunde@example.de und wähle Bearbeiten.', reason: 'Ablauf' } })).resolves.toMatchObject({ candidate: { question: 'Wie bearbeite ich Kontakte?', answer: 'Öffne den Kontakt [E-MAIL/ACCOUNT] und wähle Bearbeiten.' } })
})


describe('actual generalized appointment example', () => {
  const example = {"question": "Ein Termin per Zoom wurde bereits verbindlich bestätigt und der Link dazu bereitgestellt. Der Kunde sendet daraufhin lediglich seine Telefonnummer (z. B. 'Hi, das wäre meine Rufnummer'). Wie sollte darauf reagiert werden?", "answer": "Danke dir für deine Telefonnummer! Dein Termin bleibt wie vereinbart per Zoom bestehen. Den Zoom-Link findest du in der vorherigen Nachricht.", "reason": "Der Termin war bereits bestätigt. Die Telefonnummer ist kein Wunsch nach einem neuen Termin oder einem Wechsel zu Telefon. Bereits bekannte Zeiten nicht erneut erfragen. Nicht behaupten, eine Nummer sei im CRM gespeichert."}
  const row = { ...fixture(), ...example }
  const incoming = 'Hi, das wäre meine Rufnummer [TELEFON].'
  it.each([
    'Der Termin ist für Montag um 14:00 Uhr per Zoom bestätigt. Den Zoom-Link findest du hier: [ZOOM-LINK].',
    'Fabian freut sich auf den Call mit dir am Montag um 14:00 Uhr. Zoom: [ZOOM-LINK].',
  ])('retrieves the actual model output for delivered appointment context: %s', (history) => {
    expect(matchReviewedExamples(`${incoming}\nGesprächskontext:\n${history}`, [row])).toHaveLength(1)
  })
  it.each([
    incoming,
    `${incoming} Einen Termin haben wir noch nicht vereinbart.`,
    `${incoming} Ich möchte einen Termin per Zoom buchen und brauche dafür einen Link.`,
    `${incoming} Ich möchte den bestätigten Termin per Zoom absagen, der Link liegt vor.`,
    'Wie bearbeite ich Kontakte und hinterlege eine Telefonnummer?',
  ])('does not retrieve the appointment confirmation for another situation: %s', (query) => {
    expect(matchReviewedExamples(query, [row])).toEqual([])
  })
})
