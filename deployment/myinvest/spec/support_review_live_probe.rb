# frozen_string_literal: true

# Run using `bundle exec rails runner <path>` after the initializer is mounted.
# Read-only: exercises real PostgreSQL, finder counts, and unsaved model routing.
require 'json'

raise 'Support review initializer is not loaded' unless defined?(MyinvestSupportReview)

predicate = Conversation.send(:sanitize_sql_array, [
  MyinvestSupportReview::VISIBLE_CONVERSATIONS,
  MyinvestSupportReview::RETIRED_TEST,
  'production-e2e-%'
])
fixtures = {
  'retired_test' => { myinvest_e2e_retired: true, myinvest_production_e2e_recovery: 'production-e2e-fixture' },
  'active_test' => { myinvest_e2e_retired: false, myinvest_production_e2e_recovery: 'production-e2e-fixture' },
  'real_history' => {},
  'retired_only' => { myinvest_e2e_retired: true },
  'recovery_only' => { myinvest_production_e2e_recovery: 'production-e2e-fixture' },
  'wrong_recovery' => { myinvest_e2e_retired: true, myinvest_production_e2e_recovery: 'customer-request' },
  'string_boolean' => { myinvest_e2e_retired: 'true', myinvest_production_e2e_recovery: 'production-e2e-fixture' },
  'null_attributes' => nil
}
connection = ActiveRecord::Base.connection
values = fixtures.map do |name, attributes|
  "(#{connection.quote(name)}, #{connection.quote(attributes && JSON.generate(attributes))}::jsonb)"
end.join(', ')
actual = connection.select_values("SELECT name FROM (VALUES #{values}) AS conversations(name, custom_attributes) WHERE #{predicate}")
raise 'Retired-test predicate discarded real or unretired records' unless actual.sort == (fixtures.keys - ['retired_test']).sort

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
puts JSON.generate(status: 'passed', sql_fixture_cases: fixtures.length, inboxes_checked: account.inboxes.count, counts: counts)
