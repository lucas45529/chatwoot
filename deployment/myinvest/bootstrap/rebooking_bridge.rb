# frozen_string_literal: true

module Myinvest
  class RebookingBridge
    class ConfigurationError < StandardError; end

    INBOX_NAME = 'MyInvest Support'.freeze
    LEGACY_INBOX_NAMES = ['MyInvest Academy WhatsApp'].freeze
    LABELS = [
      {
        title: 'termin-absage',
        color: '#dc2626',
        description: 'Termin wurde per WhatsApp abgesagt'
      },
      {
        title: 'rebooking-laeuft',
        color: '#2563eb',
        description: 'Automatische Reterminierung ist aktiv'
      },
      {
        title: 'rebooking-menschlich-pruefen',
        color: '#d97706',
        description: 'Reterminierung braucht eine menschliche Pruefung'
      }
    ].freeze
    CUSTOM_ATTRIBUTES = [
      {
        key: 'myinvest_tenant',
        name: 'Mandant',
        description: 'Technisch autorisierter Support-Mandant',
        type: :text
      },
      {
        key: 'myinvest_funnel_group',
        name: 'Funnel-Gruppe',
        description: 'Konfigurierte Funnel-Zuordnung des Support-Mandanten',
        type: :text
      },
      {
        key: 'myinvest_session_id',
        name: 'Support-Sitzung',
        description: 'Pseudonyme mandantengebundene Support-Sitzung',
        type: :text
      },
      {
        key: 'myinvest_channel',
        name: 'Kanal',
        description: 'Ursprung des Support-Gespraechs',
        type: :text
      },
      {
        key: 'myinvest_appointment_owner',
        name: 'Termininhaber',
        description: 'Zustaendiger MyInvest-Berater',
        type: :text
      },
      {
        key: 'myinvest_appointment_at',
        name: 'Terminbeginn',
        description: 'Terminbeginn mit Zeitzone',
        type: :text
      },
      {
        key: 'myinvest_appointment_timezone',
        name: 'Termin-Zeitzone',
        description: 'IANA-Zeitzone des Termininhabers',
        type: :text
      },
      {
        key: 'myinvest_appointment_title',
        name: 'Termin',
        description: 'Bezeichnung des betroffenen Termins',
        type: :text
      },
      {
        key: 'myinvest_booking_uid',
        name: 'Cal Termin-ID',
        description: 'Eindeutige Cal-Buchungskennung',
        type: :text
      },
      {
        key: 'myinvest_support_state',
        name: 'Support-Status',
        description: 'Aktueller Zustand der Reterminierung',
        type: :text
      },
      {
        key: 'myinvest_review_reason',
        name: 'Prüfgrund',
        description: 'Interner Grund für eine menschliche Prüfung',
        type: :text
      },
      {
        key: 'myinvest_hubspot_contact_id',
        name: 'HubSpot Kontakt-ID',
        description: 'Eindeutige HubSpot-Kontaktkennung',
        type: :text,
        model: :contact_attribute
      },
      {
        key: 'myinvest_hubspot_contact_name',
        name: 'HubSpot Kontakt',
        description: 'In HubSpot verifizierter Kontaktname',
        type: :text,
        model: :contact_attribute
      },
      {
        key: 'myinvest_hubspot_contact_status',
        name: 'HubSpot Terminstatus',
        description: 'Verifizierter Terminstatus des Kontakts',
        type: :text,
        model: :contact_attribute
      }
    ].freeze

    def initialize(account:, administrator:, integration_user:, agent_bot:, webhook_url:)
      @account = account
      @administrator = administrator
      @integration_user = integration_user
      @agent_bot = agent_bot
      @webhook_url = webhook_url
    end

    def call
      validate_configuration!

      ActiveRecord::Base.transaction do
        inbox = provision_inbox
        provision_memberships(inbox)
        provision_custom_attributes
        provision_labels
        credentials(inbox)
      end
    end

    private

    attr_reader :account, :administrator, :integration_user, :agent_bot, :webhook_url

    def validate_configuration!
      unless account.custom_attributes['myinvest_tenant_key'] == 'new_academy'
        raise ConfigurationError, 'Rebooking API inbox requires the new_academy tenant'
      end
      raise ConfigurationError, 'Rebooking webhook URL must use HTTPS' unless webhook_url.to_s.start_with?('https://')
      raise ConfigurationError, 'Agent Bot belongs to another account' unless agent_bot.account_id == account.id
      raise ConfigurationError, 'Administrator does not belong to the account' unless administrator.accounts.exists?(id: account.id)
      raise ConfigurationError, 'Integration user must not be a SuperAdmin' if integration_user.is_a?(SuperAdmin)
      unless integration_user.accounts.pluck(:id) == [account.id]
        raise ConfigurationError, 'Integration user must belong only to the rebooking account'
      end
    end

    def provision_inbox
      managed_inboxes = account.inboxes.where(
        name: [INBOX_NAME, *LEGACY_INBOX_NAMES]
      ).to_a
      if managed_inboxes.many?
        raise ConfigurationError, 'More than one managed MyInvest support inbox exists'
      end

      inbox = managed_inboxes.first
      if inbox && !inbox.channel.is_a?(Channel::Api)
        raise ConfigurationError, "Managed support inbox is not an API inbox: #{inbox.name}"
      end

      unless inbox
        channel = Channel::Api.create!(
          account: account,
          webhook_url: webhook_url,
          hmac_mandatory: true
        )
        inbox = Inbox.create!(account: account, channel: channel, name: INBOX_NAME)
      end
      inbox.update!(name: INBOX_NAME) unless inbox.name == INBOX_NAME
      inbox.channel.update!(webhook_url: webhook_url, hmac_mandatory: true)
      inbox
    end

    def provision_memberships(inbox)
      InboxMember.find_or_create_by!(inbox: inbox, user: administrator)
      bot_inbox = AgentBotInbox.find_or_initialize_by(inbox: inbox)
      bot_inbox.assign_attributes(agent_bot: agent_bot, status: :active)
      bot_inbox.save!
    end

    def provision_custom_attributes
      CUSTOM_ATTRIBUTES.each do |definition|
        attribute = account.custom_attribute_definitions.find_or_initialize_by(
          attribute_model: definition.fetch(:model, :conversation_attribute),
          attribute_key: definition.fetch(:key)
        )
        attribute.assign_attributes(
          attribute_display_name: definition.fetch(:name),
          attribute_description: definition.fetch(:description),
          attribute_display_type: definition.fetch(:type)
        )
        attribute.save!
      end

    end

    def provision_labels
      LABELS.each do |definition|
        label = account.labels.find_or_initialize_by(title: definition.fetch(:title))
        label.assign_attributes(
          color: definition.fetch(:color),
          description: definition.fetch(:description),
          show_on_sidebar: true
        )
        label.save!
      end
    end

    def credentials(inbox)
      {
        inbox_id: inbox.id,
        webhook_secret: inbox.channel.secret,
        api_token: integration_user.access_token.token,
        agent_bot_user_id: agent_bot.id
      }
    end
  end
end
