import { describe, expect, it } from 'vitest'
import { handoffNote, normalizeForTriage, triage } from '../src/triage.js'

describe('triage', () => {
  it('rates a foreign-provider fraud report as critical and keeps it away from the model', () => {
    // Wortlaut aus dem Live-Fall WhatsApp #67 (24.08.2026).
    const outcome = triage(
      'Guten Morgen, mein Kunde wurde von einem fremden Finanzierer angeschrieben, der einen KI Avatar einer Frau verwendet, keine Telefonnummer und keinen Datenschutzlink hinterlegt hat. Außerdem soll der Kunde Dokumente auf ein Drittportal (Bonitrust) hochladen. Der Kunde findet das maximal unseriös.',
    )
    expect(outcome.category).toBe('sicherheit')
    expect(outcome.priority).toBe('urgent')
    expect(outcome.humanOnly).toBe(true)
    expect(outcome.labels).toContain('sicherheitsverdacht')
    expect(outcome.customerAck).toContain('dringend')
  })

  it('lets an access problem reach the knowledge base but still rates it high', () => {
    // Wortlaut aus dem Live-Fall WhatsApp #66 (23.08.2026).
    const outcome = triage(
      'Hallo, ich bekomme kein Zugriff auf meine MyInvest app könnt ihr mir ein link schicken wo ich mich anmelden kann?',
    )
    expect(outcome.category).toBe('zugang')
    expect(outcome.priority).toBe('high')
    expect(outcome.humanOnly).toBe(false)
  })

  it.each([
    ['Bitte löschen Sie meine Daten nach DSGVO.', 'datenschutz', 'urgent'],
    ['Ich möchte eine Beschwerde einreichen und schalte sonst meinen Anwalt ein.', 'beschwerde', 'urgent'],
    ['Bei mir wurde doppelt abgebucht, die Rechnung stimmt nicht.', 'zahlung', 'high'],
    ['Ich will mit einem Mitarbeiter sprechen, keine KI.', 'mensch', 'high'],
    ['Können wir einen Termin für ein Telefonat machen?', 'termin', 'medium'],
    ['Ist diese Klausel im Vertrag rechtlich wirksam?', 'beratung', 'medium'],
    ['Wie funktioniert das Onboarding?', 'allgemein', 'medium'],
    ['Ich finde den Button oben rechts nicht.', 'allgemein', 'medium'],
  ])('classifies %s as %s', (question, category, priority) => {
    const outcome = triage(question)
    expect(outcome.category).toBe(category)
    expect(outcome.priority).toBe(priority)
  })

  it('matches umlaut and transliterated spelling alike', () => {
    expect(normalizeForTriage('UNSERIÖS, Kündigung, Rückruf')).toBe('unserioes, kuendigung, rueckruf')
    expect(triage('Das ist unseriös.').category).toBe('sicherheit')
    expect(triage('Das ist unserioes.').category).toBe('sicherheit')
  })

  it('falls back to a general handoff for empty input', () => {
    expect(triage('   ').category).toBe('allgemein')
    expect(triage('   ').humanOnly).toBe(false)
  })

  it('writes an internal note with category, trigger and next step', () => {
    const outcome = triage('Ich möchte eine Beschwerde einreichen.')
    const note = handoffNote({ outcome, reason: 'triage_beschwerde', detail: 'top_score=none' })
    expect(note).toContain('beschwerde')
    expect(note).toContain('urgent')
    expect(note).toContain('triage_beschwerde')
    expect(note).toContain('top_score=none')
    expect(note).toContain(outcome.internalHint)
  })
})
