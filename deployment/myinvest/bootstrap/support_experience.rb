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
  DASHBOARD_SCRIPT_MARKER = 'myinvest-support-dashboard-v2'
  LEGACY_DASHBOARD_SCRIPT_MARKER = 'myinvest-default-color-scheme'
  DASHBOARD_SCRIPT = <<~HTML
    <script data-myinvest="#{DASHBOARD_SCRIPT_MARKER}">
      (function () {
        try {
          if (!window.localStorage.getItem('color_scheme')) {
            window.localStorage.setItem('color_scheme', 'light');
            window.localStorage.setItem('color_scheme:ts', String(Date.now()));
          }
        } catch (error) {}

        const draftsKey = 'draftMessages';
        const routePattern = /\\/app\\/accounts\\/(\\d+)\\/(?:[^/]+\\/)*conversations\\/(\\d+)(?:\\/|$)/;
        let syncing = false;
        const request = (url, options = {}) =>
          window.axios({ url, ...options });
        const readDrafts = () => {
          try {
            return JSON.parse(window.localStorage.getItem(draftsKey) || '{}');
          } catch (error) {
            return {};
          }
        };
        const writeDraftToStore = async (key, message) => {
          const app = document.querySelector('#app')?.__vue_app__;
          const store = app?.config?.globalProperties?.$store;
          if (typeof store?.dispatch !== 'function') return false;
          await store.dispatch('draftMessages/set', { key, message });
          return true;
        };

        // The portal supplies the authenticated review workflow. The child
        // only hands over an explicit correction and immutable source IDs.
        const learningHosts = new Set([
          'https://www.myinvest-pro.de',
          'https://app.myinvest-pro.de',
        ]);
        let learningHost = null;
        const originalDraft = (note) => {
          if (typeof note !== 'string') return '';
          const marker = '\\n\\nAntwortvorschlag:\\n';
          const start = note.indexOf(marker);
          if (start < 0) return '';
          const body = note.slice(start + marker.length);
          const end = Math.max(body.lastIndexOf('\\nQuellen:'), body.lastIndexOf('\\nGrundlage:'));
          return end < 0 ? '' : body.slice(0, end).trim();
        };
        const learningIntent = (box) => {
          const route = window.location.pathname.match(routePattern);
          if (!route || !learningHost) return null;
          let component = box?.__vueParentComponent;
          while (component && typeof component.proxy?.saveDraft !== 'function') component = component.parent;
          const editor = component?.proxy;
          if (!editor || editor.isPrivate || editor.isEditorDisabled || editor.replyType !== 'REPLY') return null;
          const accountId = Number(route[1]);
          const conversationId = Number(route[2]);
          if (Number(editor.currentChat?.id) !== conversationId) return null;
          const correctedAnswer = typeof editor.message === 'string' ? editor.message.trim() : '';
          if (correctedAnswer.length < 10 || correctedAnswer.length > 4000) return null;
          const notes = [...(editor.currentChat.messages || [])].sort((a, b) => b.id - a.id);
          for (const note of notes) {
            if (!note.private || (note.sender?.type !== 'agent_bot' && note.sender_type !== 'AgentBot')) continue;
            let attributes = note.content_attributes;
            if (typeof attributes === 'string') {
              try { attributes = JSON.parse(attributes); } catch (error) { continue; }
            }
            if (!['draft_note', 'clarify_draft_note', 'handoff_note'].includes(attributes?.myinvest_agent_message_kind)) continue;
            const previousDraft = originalDraft(note.content);
            if (!previousDraft) continue;
            if (correctedAnswer === previousDraft) return null;
            const source = {
              accountId, conversationId,
              questionMessageId: Number(attributes.myinvest_agent_delivery_id),
              draftMessageId: Number(note.id),
            };
            if (!Object.values(source).every(value => Number.isSafeInteger(value) && value > 0)) return null;
            // The draft is written before its private note. Public replies
            // consume it, and a later customer question makes it ambiguous.
            if (notes.some(message => message.private === false &&
              [0, 1, 'incoming', 'outgoing'].includes(message.message_type) &&
              Number(message.id) > source.questionMessageId)) return null;
            return { type: 'myinvest-support-learning', version: 1, source, correctedAnswer };
          }
          return null;
        };
        const updateLearningButton = () => {
          const box = document.querySelector('.reply-box');
          const actions = box?.querySelector('.right-wrap');
          if (!actions || !learningHost) return;
          let button = actions.querySelector('[data-myinvest-learning]');
          if (!button) {
            actions.classList.add('gap-2');
            button = document.createElement('button');
            button.type = 'button';
            button.dataset.myinvestLearning = '1';
            button.className = actions.querySelector('button')?.className || '';
            button.textContent = 'Daraus lernen';
            button.addEventListener('click', () => {
              const intent = learningIntent(box);
              if (intent) window.parent.postMessage(intent, learningHost);
            });
            actions.prepend(button);
          }
          button.disabled = !learningIntent(box);
          button.title = button.disabled
            ? 'Bearbeite zuerst einen KI-Antwortentwurf, um die Korrektur ins Lernen zu übernehmen.'
            : 'Korrektur im internen Lernen prüfen';
        };
        window.addEventListener('message', (event) => {
          const data = event.data;
          if (window.parent === window || event.source !== window.parent || !learningHosts.has(event.origin)) return;
          if (!data || Object.keys(data).length !== 2 || data.type !== 'myinvest-support-learning-host' || data.version !== 1) return;
          learningHost = event.origin;
          updateLearningButton();
        });
        document.addEventListener('input', updateLearningButton);
        window.setInterval(updateLearningButton, 300);
        const syncDraft = async () => {
          if (syncing || !window.axios) return;
          const route = window.location.pathname.match(routePattern);
          if (!route) return;
          syncing = true;
          try {
            const [, accountId, conversationId] = route;
            const draftKey = `draft-${conversationId}-REPLY`;
            const syncKey = `myinvest-synced-draft-${accountId}-${conversationId}`;
            const clearedKey = `myinvest-cleared-draft-${accountId}-${conversationId}`;
            const endpoint =
              `/api/v1/accounts/${accountId}/conversations/${conversationId}/draft_messages`;
            const drafts = readDrafts();
            const localDraft = typeof drafts[draftKey] === 'string' ? drafts[draftKey] : '';
            const syncedDraft = window.localStorage.getItem(syncKey) || '';

            if (syncedDraft && !localDraft) {
              await request(endpoint, { method: 'DELETE' });
              window.localStorage.removeItem(syncKey);
              window.localStorage.setItem(clearedKey, syncedDraft);
              return;
            }

            const response = await request(endpoint);
            const payload = response.data || {};
            const serverDraft =
              payload.has_draft && typeof payload.message === 'string' ? payload.message : '';
            if (!serverDraft) {
              window.localStorage.removeItem(clearedKey);
              return;
            }
            if (localDraft) {
              // Local text that differs from the last synchronized value is a
              // human edit and therefore wins. An untouched synchronized draft
              // may be replaced when the server publishes a fresher AI draft.
              if (!syncedDraft) return;
              if (localDraft !== syncedDraft) {
                await request(endpoint, {
                  method: 'PATCH',
                  data: { draft_message: { message: localDraft } },
                });
                window.localStorage.setItem(syncKey, localDraft);
                return;
              }
              if (serverDraft !== syncedDraft) {
                const updatedStore = await writeDraftToStore(draftKey, serverDraft);
                if (!updatedStore) {
                  drafts[draftKey] = serverDraft;
                  window.localStorage.setItem(draftsKey, JSON.stringify(drafts));
                  window.localStorage.setItem(`${draftsKey}:ts`, String(Date.now()));
                }
                window.localStorage.setItem(syncKey, serverDraft);
                window.location.reload();
              }
              return;
            }
            if (window.localStorage.getItem(clearedKey) === serverDraft) return;

            const freshDrafts = readDrafts();
            const freshReply =
              typeof freshDrafts[draftKey] === 'string' ? freshDrafts[draftKey] : '';
            const freshNote = freshDrafts[`draft-${conversationId}-NOTE`] || '';
            if (freshReply || freshNote) return;
            const updatedStore = await writeDraftToStore(draftKey, serverDraft);
            if (!updatedStore) {
              freshDrafts[draftKey] = serverDraft;
              window.localStorage.setItem(draftsKey, JSON.stringify(freshDrafts));
              window.localStorage.setItem(`${draftsKey}:ts`, String(Date.now()));
            }
            window.localStorage.setItem(syncKey, serverDraft);
            window.location.reload();
          } catch (error) {
            // The private answer-proposal note remains the fail-safe surface.
          } finally {
            syncing = false;
          }
        };

        window.setInterval(syncDraft, 1000);
        window.addEventListener('popstate', syncDraft);
        window.addEventListener('hashchange', syncDraft);
        window.setTimeout(syncDraft, 0);
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
    { title: 'beratung', color: '#64748b', description: 'Individuelle Steuer-, Rechts- oder Anlagefrage' },
    { title: 'mensch-gewuenscht', color: '#6366f1', description: 'Kunde verlangt ausdruecklich einen Menschen' },
    { title: 'ki-entwurf', color: '#14b8a6', description: 'KI-Antwort wartet auf menschliche Freigabe' }
  ].freeze
  HANDOFF_LABEL_TITLES = HANDOFF_LABELS.map { |label| label.fetch(:title) }.freeze
  # Labels gehoeren ausschliesslich in die drei kanonischen MyInvest-Accounts.
  # Ein Schreibzugriff auf fremde Accounts derselben Chatwoot-Instanz waere ein
  # Datenfehler, deshalb wird hier aufgeloest statt ueber alle Accounts gelaufen.
  TENANT_KEYS = %w[saas new_academy legacy_academy].freeze
  AGENT_BOT_NAME = 'MyInvest Support'
  LEGACY_AGENT_BOT_NAME = 'MyInvest Claude Support'

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
      agent_bot_renames: managed_agent_bots.filter_map { |bot| bot.id if bot.name == LEGACY_AGENT_BOT_NAME },
      handoff_assignees: handoff_assignees,
    }
    return plan.merge(status: 'planned') if dry_run

    ActiveRecord::Base.transaction do
      apply_dashboard_theme!
      disable_bot_greetings!
      rename_agent_bots!
      upsert_labels!
    end
    GlobalConfig.clear_cache
    plan.merge(status: 'applied')
  end

  private

  attr_reader :dry_run, :handoff_assignees_json

  def dashboard_theme_state
    current = InstallationConfig.find_by(name: 'DASHBOARD_SCRIPTS')&.value.to_s
    return 'present' if current == DASHBOARD_SCRIPT
    return 'owned_legacy' if current.include?(DASHBOARD_SCRIPT_MARKER) ||
                             current.include?(LEGACY_DASHBOARD_SCRIPT_MARKER)

    current.strip.empty? ? 'missing' : 'foreign_value'
  end

  def apply_dashboard_theme!
    state = dashboard_theme_state
    # Fremden Inhalt niemals ueberschreiben; Greeting und Labels bleiben davon
    # unabhaengig und werden trotzdem konfiguriert.
    return if %w[present foreign_value].include?(state)

    config = InstallationConfig.find_or_initialize_by(name: 'DASHBOARD_SCRIPTS')
    config.value = DASHBOARD_SCRIPT
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

  def managed_agent_bots
    @managed_agent_bots ||= tenant_accounts.map do |account|
      bots = AgentBot.where(
        account: account,
        name: [AGENT_BOT_NAME, LEGACY_AGENT_BOT_NAME]
      ).to_a
      raise "Account #{account.id} must resolve to exactly one managed AgentBot" unless bots.one?

      bots.first
    end
  end

  def rename_agent_bots!
    managed_agent_bots.each do |agent_bot|
      agent_bot.update!(
        name: AGENT_BOT_NAME,
        description: "Tenant-scoped MyInvest support assistant for #{agent_bot.account.name}"
      )
    end
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
