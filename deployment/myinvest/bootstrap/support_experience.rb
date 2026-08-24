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
# 3. Die Labels der KI-Uebergabe in den drei kanonischen Mandanten-Accounts,
#    damit Filter und Uebersicht sie kennen.
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
  HANDOFF_LABEL_TITLES = HANDOFF_LABELS.map { |label| label.fetch(:title) }.freeze
  # Labels gehoeren ausschliesslich in die drei kanonischen MyInvest-Accounts.
  # Ein Schreibzugriff auf fremde Accounts derselben Chatwoot-Instanz waere ein
  # Datenfehler, deshalb wird hier aufgeloest statt ueber alle Accounts gelaufen.
  TENANT_KEYS = %w[saas new_academy legacy_academy].freeze

  def initialize(dry_run: true, handoff_assignees_json: ENV.fetch('SUPPORT_HANDOFF_ASSIGNEES_JSON', nil))
    @dry_run = dry_run
    @handoff_assignees_json = handoff_assignees_json
  end

  def call
    handoff_assignees = validate_handoff_assignees!
    plan = {
      mode: dry_run ? 'dry-run' : 'apply',
      dashboard_theme: dashboard_theme_state,
      greeting_inboxes: bot_inboxes_with_greeting.map(&:id),
      missing_labels: missing_labels_by_account,
      handoff_assignees: handoff_assignees,
    }
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

  attr_reader :dry_run, :handoff_assignees_json

  def dashboard_theme_state
    current = InstallationConfig.find_by(name: 'DASHBOARD_SCRIPTS')&.value.to_s
    return 'present' if current.include?(DASHBOARD_THEME_MARKER)

    current.strip.empty? ? 'missing' : 'foreign_value'
  end

  def apply_dashboard_theme!
    state = dashboard_theme_state
    # Fremden Inhalt niemals ueberschreiben; Greeting und Labels bleiben davon
    # unabhaengig und werden trotzdem konfiguriert.
    return if %w[present foreign_value].include?(state)

    config = InstallationConfig.find_or_initialize_by(name: 'DASHBOARD_SCRIPTS')
    config.value = DASHBOARD_LIGHT_SCRIPT
    config.locked = false
    config.save!
  end

  def bot_inboxes_with_greeting
    Inbox.where(account_id: tenant_accounts.map(&:id)).includes(:agent_bot_inbox).select do |inbox|
      inbox.agent_bot_inbox.present? && inbox.greeting_enabled?
    end
  end

  def disable_bot_greetings!
    bot_inboxes_with_greeting.each { |inbox| inbox.update!(greeting_enabled: false) }
  end

  # Genau ein Account je kanonischem Mandantenschluessel. Die Aufloesung laeuft
  # schon beim Plan, ein Treffer zu viel oder zu wenig bricht also ab, bevor
  # irgendetwas geschrieben wird.
  def tenant_accounts
    @tenant_accounts ||= TENANT_KEYS.map do |tenant_key|
      matches = Account.where("custom_attributes ->> 'myinvest_tenant_key' = ?", tenant_key).to_a
      raise "Tenant #{tenant_key} must resolve to exactly one account" unless matches.one?

      matches.first
    end
  end

  def validate_handoff_assignees!
    raise 'SUPPORT_HANDOFF_ASSIGNEES_JSON is required' if handoff_assignees_json.blank?

    entries = JSON.parse(handoff_assignees_json)
    unless entries.is_a?(Array) && entries.map { |entry| entry.fetch('key') }.sort == TENANT_KEYS.sort
      raise 'Support handoff assignees must contain exactly the canonical tenants'
    end
    by_key = entries.to_h { |entry| [entry.fetch('key'), entry] }
    tenant_accounts.to_h do |account|
      tenant_key = account.custom_attributes.fetch('myinvest_tenant_key')
      entry = by_key.fetch(tenant_key)
      account_id = entry.fetch('accountId')
      assignee_id = entry.fetch('handoffAssigneeId')
      unless account_id == account.id && assignee_id.is_a?(Integer) && assignee_id.positive? &&
             account.account_users.exists?(user_id: assignee_id)
        raise "Invalid handoff assignee for tenant #{tenant_key}"
      end
      [tenant_key, assignee_id]
    end
  rescue JSON::ParserError, KeyError, TypeError
    raise 'SUPPORT_HANDOFF_ASSIGNEES_JSON is invalid'
  end

  def missing_labels_by_account
    tenant_accounts.to_h { |account| [account.id, HANDOFF_LABEL_TITLES - account.labels.pluck(:title)] }
  end

  def upsert_labels!
    tenant_accounts.each do |account|
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
