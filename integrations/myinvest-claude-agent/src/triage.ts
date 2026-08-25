// Deterministische Ersteinschaetzung jeder Kundennachricht.
//
// Warum deterministisch und nicht per Modell: die Einschaetzung muss auch dann
// greifen, wenn der LLM-Aufruf scheitert, langsam ist oder eine harmlose
// Marketing-Antwort auf eine Beschwerde formuliert. Live-Beleg (24.08.2026):
// auf die Meldung "fremder Finanzierer mit KI-Avatar, kein Datenschutzlink,
// Upload auf ein Drittportal" lieferte das Modell im Test den Satz "Das
// Misstrauen deines Kunden ist absolut verstaendlich ..." — fuer einen
// moeglichen Betrugsfall die falsche Reaktion. Solche Faelle gehen deshalb ohne
// Modellumweg an einen Menschen, mit Prioritaet, Label, Notiz und einer
// sichtbaren Antwort an den Kunden.

export type HandoffCategory =
  | 'sicherheit'
  | 'datenschutz'
  | 'beschwerde'
  | 'zahlung'
  | 'mensch'
  | 'termin'
  | 'zugang'
  | 'beratung'
  | 'allgemein'

/** Von Chatwoot akzeptierte Prioritaeten (`POST conversations/:id/toggle_priority`). */
export type ConversationPriority = 'urgent' | 'high' | 'medium' | 'low'

export interface TriageOutcome {
  readonly category: HandoffCategory
  readonly priority: ConversationPriority
  /** ASCII-Slugs; Chatwoot-Labels erlauben keine Umlaute/Leerzeichen. */
  readonly labels: readonly string[]
  /** Interne Notiz fuer das Team: Lage + naechster Schritt. */
  readonly internalHint: string
  /** Sichtbare Nachricht an den Kunden, sobald uebergeben wird. */
  readonly customerAck: string
  /**
   * true = diese Nachricht darf das Modell gar nicht beantworten. Sie geht
   * direkt an einen Menschen, weil eine automatische Antwort hier mehr Schaden
   * anrichtet als hilft.
   */
  readonly humanOnly: boolean
}

interface TriageRule extends TriageOutcome {
  readonly pattern: RegExp
}

const HANDOFF_LABEL = 'ki-uebergabe'

/** ae/oe/ue/ss-Normalisierung, damit "unserioes" und "unseriös" gleich matchen. */
export function normalizeForTriage(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim()
}

const SUPPORT_PRESENCE_REPLY = 'Hey, ja — wir sind da. Wie können wir dir helfen?'
const PRESENCE_OR_GREETING =
  /^(?:hallo|hi|hey|moin|guten morgen|guten tag|guten abend|ist jemand (?:da|hier)|seid ihr (?:da|hier)|jemand (?:da|hier)|koennt ihr mir helfen|kann mir jemand helfen|ich brauche hilfe|brauche hilfe)$/

/**
 * Antworten, die kein Wissensdokument brauchen. Nur vollstaendige, kurze
 * Praesenz-/Begruessungsfragen matchen; "Guten Morgen, mein Kunde wurde ..."
 * laeuft deshalb weiter durch die kritische Triage.
 */
export function directSupportReply(input: string): string | undefined {
  const normalized = normalizeForTriage(input)
    .replace(/[!?.,:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return PRESENCE_OR_GREETING.test(normalized) ? SUPPORT_PRESENCE_REPLY : undefined
}

// Reihenfolge = Rangfolge: die erste passende Regel gewinnt. Schwere Faelle
// stehen oben, damit "Beschwerde ueber einen fremden Anbieter" nicht als
// harmlose Terminfrage endet.
const RULES: readonly TriageRule[] = [
  {
    category: 'sicherheit',
    pattern:
      /(?:fremd\w*|anderer|andere|dritt\w*|unbekannt\w*)\s+(?:finanzier\w*|anbieter|vermittler|makler|berater\w*|portal|firma)|\bunserioes\w*|\bbetrug\w*|\bbetrueg\w*|\bphishing\b|\babzock\w*|\bmasche\b|\bgefaelsch\w*|\bfake\b|\bki[- ]avatar\b|\bavatar einer frau\b|\bdrittportal\w*|\bbonitrust\b|\bkein impressum\b|\bkeinen datenschutzlink\b|\bidentitaet\w* (?:missbrauch\w*|geklaut|gestohlen)/,
    priority: 'urgent',
    labels: [HANDOFF_LABEL, 'sicherheitsverdacht'],
    internalHint:
      'Moeglicher Missbrauch/unseriöser Dritter im Namen von MyInvest. Bitte Sachverhalt aufnehmen, Kunden warnen und intern prüfen, ob echte Partnerdaten betroffen sind.',
    customerAck:
      'Danke, dass du das direkt meldest — das nehmen wir sehr ernst. Ich habe den Fall als dringend markiert und an einen Kollegen im Team übergeben, der sich persönlich bei dir meldet. Bitte lade bis dahin keine Unterlagen auf Portale hoch, die du nicht sicher kennst.',
    humanOnly: true,
  },
  {
    category: 'datenschutz',
    pattern:
      /\bdatenschutz\w*|\bdsgvo\b|\bgdpr\b|\bdaten (?:loeschen|geloescht|weitergegeben|verkauft|missbraucht)|\bloeschung meiner daten\b|\bauskunft\w* nach\b|\bart\.? ?15\b/,
    priority: 'urgent',
    labels: [HANDOFF_LABEL, 'datenschutz'],
    internalHint:
      'Datenschutz-Anliegen — fristgebunden. Bitte persönlich beantworten und intern dokumentieren.',
    customerAck:
      'Danke für deine Nachricht. Datenschutz-Themen beantwortet bei uns immer ein Mensch, deshalb habe ich das direkt als dringend an einen Kollegen übergeben. Er meldet sich persönlich bei dir.',
    humanOnly: true,
  },
  {
    category: 'beschwerde',
    pattern:
      /\bbeschwer(?:de|en|t)\w*|\banwalt\w*|\brechtsanwalt\w*|\babmahnung\w*|\bwiderruf\w*|\bkuendig\w*|\brueckerstattung\w*|\berstattung\b|\brefund\b|\bunzufrieden\b|\beskalier\w*|\bverbraucherzentrale\b|\bbafin\b/,
    priority: 'urgent',
    labels: [HANDOFF_LABEL, 'beschwerde'],
    internalHint:
      'Beschwerde/Vertragsthema. Bitte selbst antworten, keine Standardantwort.',
    customerAck:
      'Danke, dass du das so offen sagst. Ich habe deinen Fall als dringend an einen Kollegen übergeben, der sich persönlich bei dir meldet.',
    humanOnly: true,
  },
  {
    category: 'zahlung',
    pattern:
      /\brechnung\w*|\bzahlung\w*|\bbezahl\w*|\babbuch\w*|\blastschrift\w*|\bkreditkarte\w*|\bmahnung\w*|\bdoppelt abgebucht\b|\bnicht (?:bezahlt|gezahlt)\b|\bprovision\w* (?:nicht|fehlt|offen)/,
    priority: 'high',
    labels: [HANDOFF_LABEL, 'zahlung'],
    internalHint:
      'Zahlungs-/Abrechnungsthema. Bitte im Backoffice prüfen, bevor geantwortet wird.',
    customerAck:
      'Danke für die Info. Rechnungen und Zahlungen schaut sich ein Kollege direkt an — er meldet sich bei dir, sobald er es geprüft hat.',
    humanOnly: true,
  },
  {
    category: 'mensch',
    pattern:
      /\bmenschen?\b|\bmitarbeiter(?:in)?\b|\bechte person\b|\bkeine ki\b|\bkein bot\b|\bberater(?:in)? sprechen\b|\bsupport[- ]?team\b/,
    priority: 'high',
    labels: [HANDOFF_LABEL, 'mensch-gewuenscht'],
    internalHint: 'Kunde hat ausdrücklich einen Menschen verlangt.',
    customerAck:
      'Klar, ich hole einen Kollegen dazu — er meldet sich bei dir.',
    humanOnly: true,
  },
  {
    category: 'termin',
    pattern:
      /\btermin\w*|\brueckruf\w*|\bruf(?:t|en)? mich\b|\banrufen\b|\btelefonat\w*|\bmeeting\b|\bzoom\b|\bgespraech vereinbaren\b/,
    priority: 'medium',
    labels: [HANDOFF_LABEL, 'termin'],
    internalHint: 'Termin-/Rückrufwunsch. Bitte Zeitfenster abstimmen.',
    customerAck:
      'Alles klar, den Termin stimmt ein Kollege direkt mit dir ab. Ich habe deine Nachricht schon weitergegeben.',
    // Die inhaltliche Sicherheitsgrenze zieht die Gehirn-Policy, nicht die
    // Triage: eine Terminfrage darf beantwortet werden, ein Zusagetext nicht.
    humanOnly: false,
  },
  {
    category: 'zugang',
    pattern:
      /\bkein(?:en)? (?:zugriff|zugang)\b|\bkomme nicht (?:rein|drauf|hinein)\b|\bpasswort\w*|\banmelde\w*|\beinlog\w*|\blogin\b|\bzugangslink\w*|\bfreischalt\w*|\bzurueckset\w*|\b2fa\b|\bcode (?:nicht|kommt nicht)\b/,
    priority: 'high',
    labels: [HANDOFF_LABEL, 'zugang'],
    internalHint:
      'Zugangsproblem — Kunde ist blockiert. Bitte Account prüfen und Zugang wiederherstellen.',
    customerAck:
      'Ich habe das an einen Kollegen übergeben, der deinen Zugang direkt prüft und sich bei dir meldet.',
    humanOnly: false,
  },
  {
    category: 'beratung',
    pattern:
      /\bsteuer\w*|\bversteuer\w*|\brecht(?:lich|e|er)?\b|\bvertrag\w*|\bklausel\w*|\bhaftung\w*|\banlageberat\w*|\bempfehl\w*|\binvestmentberat\w*|\bfoerder\w* pruef\w*|\bpreis\w*|\bkosten\b|\bwas kostet\b|\bwelche (?:anlage|immobilie)\b|\bbeste rendite\b|\bsoll ich (?:kaufen|investieren|unterschreiben)\b|\brendite\w* (?:fuer mich|meines)|\bobjekt\w* pruef\w*/,
    priority: 'medium',
    labels: [HANDOFF_LABEL, 'beratung'],
    internalHint:
      'Individuelle Steuer-, Rechts-, Preis- oder Anlagefrage — keine automatische Antwort erlaubt.',
    customerAck:
      'Das schaut sich am besten ein Kollege persönlich mit dir an, weil es von deiner Situation abhängt. Ich habe deine Frage direkt weitergegeben.',
    humanOnly: true,
  },
]

const FALLBACK: TriageOutcome = {
  category: 'allgemein',
  priority: 'medium',
  labels: [HANDOFF_LABEL],
  internalHint:
    'Die KI konnte die Frage nicht belegt beantworten. Bitte selbst antworten — und die Antwort ins Wissen aufnehmen, falls sie sich wiederholt.',
  customerAck:
    'Danke für deine Nachricht. Ich gebe das direkt an einen Kollegen weiter, der sich bei dir meldet.',
  humanOnly: false,
}

export function triage(question: string): TriageOutcome {
  const normalized = normalizeForTriage(question)
  if (!normalized) return FALLBACK
  const match = RULES.find((rule) => rule.pattern.test(normalized))
  if (!match) return FALLBACK
  const { pattern: _pattern, ...outcome } = match
  return outcome
}

/**
 * Interne Notiz fuer das Team. Enthaelt den technischen Grund (fuer die
 * Fehlersuche) und den fachlichen naechsten Schritt (fuer den Menschen).
 */
export function handoffNote(input: {
  outcome: TriageOutcome
  reason: string
  detail?: string
}): string {
  const lines = [
    `KI-Übergabe · ${input.outcome.category} · Priorität ${input.outcome.priority}`,
    input.outcome.internalHint,
    `Auslöser: ${input.reason}${input.detail ? ` (${input.detail})` : ''}`,
  ]
  return lines.join('\n')
}
