# frozen_string_literal: true

require 'json'

module Myinvest; end

# Idempotente Einstellungen fuer das Support-Erlebnis. Reine Konfiguration,
# keine Schemaaenderung, kein Datenzugriff auf Kundeninhalte:
#
# 1. Helles Dashboard als Standard. Chatwoot entscheidet das Theme im Browser
#    (localStorage 'color_scheme', Default 'auto' = Systemeinstellung). Ohne
#    eigenen Image-Build ist DASHBOARD_SCRIPTS der einzige serverseitige Hebel.
# 2. Kein statischer Begruessungsbaustein auf Inboxen mit KI-Bot. Das Greeting
#    wurde nach der Kundenfrage gesendet und las sich wie eine Nichtantwort
#    ("Schreib uns dein Anliegen"), obwohl der Bot in Sekunden selbst antwortet.
# 3. Die Labels der KI-Uebergabe, damit Filter und Uebersicht sie kennen.
class Myinvest::SupportExperience
  DASHBOARD_THEME_MARKER = 'myinvest-default-color-scheme'
  DASHBOARD_LIGHT_SCRIPT = <<~HTML
    <script data-myinvest="#{DASHBOARD_THEME_MARKER}">
      // Helles Dashboard als Standard. Eine bewusste Auswahl des Agenten
      // (Darstellung -> Dunkel/Automatisch) bleibt unangetastet.
      (function () {
        try {
          if (!window.localStorage.getItem('color_scheme')) {
            window.localStorage.setItem('color_scheme', 'light');
            window.localStorage.setItem('color_scheme:ts', String(Date.now()));
          }
        } catch (error) {
          // localStorage kann blockiert sein - dann gilt der Chatwoot-Standard.
        }
      })();
    </script>
  HTML

  HANDOFF_LABELS = [
    { title: 'ki-uebergabe', color: '#1f93ff', description: 'Von der KI an einen Menschen uebergeben' },
    { title: 'sicherheitsverdacht', color: '#dc2626', description: 'Moeglicher Missbrauch oder unserioeser Dritter' },
    { title: 'datenschutz', color: '#7c3aed', description: 'Datenschutz-, Loeschungs- oder Auskunftsanliegen' },
    { title: 'beschwerde', color: '#ea580c', description: 'Beschwerde, Widerruf oder Kuendigung' },
    { title: 'zahlung', color: '#f59e0b', description: 'Rechnung, Zahlung oder Abrechnung' },
    { title: 'zugang', color: '#0ea5e9', description: 'Zugang, Login oder Freischaltung' },
    { title: 'termin', color: '#22c55e', description: 'Termin- oder Rueckrufwunsch' },
    { title: 'beratung', color: '#64748b', description: 'Individuelle Steuer-, Rechts- oder Anlagefrage' }
  ].freeze

  def initialize(dry_run: true)
    @dry_run = dry_run
  end

  def call
    plan = { mode: dry_run ? 'dry-run' : 'apply', dashboard_theme: dashboard_theme_state, greeting_inboxes: bot_inboxes_with_greeting.map(&:id),
             missing_labels: missing_labels_by_account }
    return plan.merge(status: 'planned') if dry_run

    ActiveRecord::Base.transaction do
      apply_dashboard_theme!
      disable_bot_greetings!
      upsert_labels!
    end
    GlobalConfig.clear_cache
    plan.merge(status: 'applied')
  end

  private

  attr_reader :dry_run

  def dashboard_theme_state
    current = InstallationConfig.find_by(name: 'DASHBOARD_SCRIPTS')&.value.to_s
    return 'present' if current.include?(DASHBOARD_THEME_MARKER)

    current.strip.empty? ? 'missing' : 'foreign_value'
  end

  def apply_dashboard_theme!
    state = dashboard_theme_state
    return if state == 'present'
    # Fremden Inhalt niemals ueberschreiben: dann bleibt alles, wie es ist.
    raise "DASHBOARD_SCRIPTS carries foreign content; refusing to overwrite" if state == 'foreign_value'

    config = InstallationConfig.find_or_initialize_by(name: 'DASHBOARD_SCRIPTS')
    config.value = DASHBOARD_LIGHT_SCRIPT
    config.locked = false
    config.save!
  end

  def bot_inboxes_with_greeting
    Inbox.includes(:agent_bot_inbox).select { |inbox| inbox.agent_bot_inbox.present? && inbox.greeting_enabled? }
  end

  def disable_bot_greetings!
    bot_inboxes_with_greeting.each { |inbox| inbox.update!(greeting_enabled: false) }
  end

  def missing_labels_by_account
    Account.all.to_h do |account|
      existing = account.labels.pluck(:title)
      [account.id, HANDOFF_LABELS.map { |label| label.fetch(:title) } - existing]
    end
  end

  def upsert_labels!
    Account.find_each do |account|
      HANDOFF_LABELS.each do |attributes|
        label = account.labels.find_or_initialize_by(title: attributes.fetch(:title))
        label.color = attributes.fetch(:color)
        label.description = attributes.fetch(:description)
        label.show_on_sidebar = true
        label.save!
      end
    end
  end
end

if ENV['SUPPORT_EXPERIENCE_RUN'] == 'true'
  dry_run = ENV.fetch('SUPPORT_EXPERIENCE_MODE', 'dry-run') != 'apply'
  output = Myinvest::SupportExperience.new(dry_run: dry_run).call
  # rubocop:disable Rails/Output -- machine-readable command output is the interface.
  $stdout.write("#{JSON.generate(output)}\n")
  # rubocop:enable Rails/Output
end
