# frozen_string_literal: true

# Run using `bundle exec rails runner <path>` after the initializer is mounted.
# Read-only: exercises real PostgreSQL, finder counts, and unsaved model routing.
require 'json'

raise 'Support review initializer is not loaded' unless defined?(MyinvestSupportReview)

predicate = Conversation.send(:sanitize_sql_array, [
  MyinvestSupportReview::VISIBLE_CONVERSATIONS,
  MyinvestSupportReview::RETIRED_TEST,
  MyinvestSupportReview::RECOVERY_MARKER
])
fixtures = {
  'retired_test' => { myinvest_e2e_retired: true, myinvest_production_e2e_recovery: 'production-e2e-20260905T080000Z-0123456789abcdef0123456789abcdef' },
  'active_test' => { myinvest_e2e_retired: false, myinvest_production_e2e_recovery: 'production-e2e-20260905T080000Z-0123456789abcdef0123456789abcdef' },
  'real_history' => {},
  'retired_only' => { myinvest_e2e_retired: true },
  'recovery_only' => { myinvest_production_e2e_recovery: 'production-e2e-20260905T080000Z-0123456789abcdef0123456789abcdef' },
  'wrong_recovery' => { myinvest_e2e_retired: true, myinvest_production_e2e_recovery: 'customer-request' },
  'string_boolean' => { myinvest_e2e_retired: 'true', myinvest_production_e2e_recovery: 'production-e2e-20260905T080000Z-0123456789abcdef0123456789abcdef' },
  'invalid_marker' => { myinvest_e2e_retired: true, myinvest_production_e2e_recovery: 'production-e2e-customer-value' },
  'null_attributes' => nil
}
connection = ActiveRecord::Base.connection
values = fixtures.map do |name, attributes|
  "(#{connection.quote(name)}, #{connection.quote(attributes && JSON.generate(attributes))}::jsonb)"
end.join(', ')
actual = connection.select_values("SELECT name FROM (VALUES #{values}) AS conversations(name, custom_attributes) WHERE #{predicate}")
raise 'Retired-test predicate discarded real or unretired records' unless actual.sort == (fixtures.keys - ['retired_test']).sort

message_predicate = Conversation.send(:sanitize_sql_array, [
  MyinvestSupportReview::VISIBLE_MESSAGES, MyinvestSupportReview::RETIRED_TEST, MyinvestSupportReview::RECOVERY_MARKER
])
contact_predicate = Conversation.send(:sanitize_sql_array, [
  MyinvestSupportReview::VISIBLE_CONTACTS, MyinvestSupportReview::RETIRED_TEST, MyinvestSupportReview::RECOVERY_MARKER
])
conversation_fixtures = [
  [1, 1, 1, fixtures.fetch('retired_test')],
  [2, 1, 2, fixtures.fetch('real_history')],
  [3, 1, 2, fixtures.fetch('retired_test')],
  [4, 1, 3, fixtures.fetch('invalid_marker')],
  [5, 2, 4, fixtures.fetch('retired_test')]
].map do |id, account_id, contact_id, attributes|
  "(#{id}, #{account_id}, #{contact_id}, #{connection.quote(JSON.generate(attributes))}::jsonb)"
end.join(', ')
conversation_cte = "WITH conversations(id, account_id, contact_id, custom_attributes) AS (VALUES #{conversation_fixtures})"
message_results = connection.select_values(<<~SQL)
  #{conversation_cte}
  SELECT name FROM (VALUES
    ('retired', 1, 1), ('real', 2, 1), ('cross_account', 1, 2), ('invalid_marker', 4, 1)
  ) AS messages(name, conversation_id, account_id) WHERE #{message_predicate}
SQL
raise 'Message search leaked a retired thread or hid real data' unless message_results.sort == %w[cross_account invalid_marker real]
contact_results = connection.select_values(<<~SQL)
  #{conversation_cte}
  SELECT name FROM (VALUES
    ('retired_only', 1, 1), ('mixed', 2, 1), ('invalid_marker', 3, 1), ('cross_account', 4, 1), ('empty', 6, 1)
  ) AS contacts(name, id, account_id) WHERE #{contact_predicate}
SQL
raise 'Contact search hid a real, mixed, or empty history' unless contact_results.sort == %w[cross_account empty invalid_marker mixed]

account = Account.find_by!(
  "custom_attributes @> ?::jsonb", JSON.generate(managed_by: 'myinvest-bootstrap', myinvest_tenant_key: 'saas')
)
reviewer = account.users.find_by!(email: ENV.fetch('INTERN_SSO_EMAIL'))
registered = Conversation._create_callbacks.any? { |callback| callback.filter == :myinvest_assign_support_reviewer }
raise 'Assignment callback is not registered' unless registered
account.inboxes.find_each do |inbox|
  candidate = Conversation.new(account: account, inbox: inbox)
  candidate.send(:myinvest_assign_support_reviewer)
  assigned = candidate.assignee_id == reviewer.id && candidate.assignee_agent_bot_id.nil?
  raise 'Unsaved conversation did not receive the internal reviewer' unless assigned
end

Current.account = account
counts = %w[all resolved].to_h do |status|
  metadata = ConversationFinder.new(reviewer, { status: status, assignee_type: 'all' }).perform_meta_only.fetch(:count)
  [status, metadata]
end
puts JSON.generate(status: 'passed', sql_fixture_cases: fixtures.length + 9, inboxes_checked: account.inboxes.count, counts: counts)
