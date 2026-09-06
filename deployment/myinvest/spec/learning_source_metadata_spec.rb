# frozen_string_literal: true

require 'minitest/autorun'
require 'json'
require 'digest'
require 'tmpdir'
require 'fileutils'
require 'open3'
require 'rbconfig'

class LearningSourceMetadataSpec < Minitest::Test
  def setup
    @directory = Dir.mktmpdir('learning-source-metadata')
    @runtime = File.join(@directory, 'tenants.json')
    @env = File.join(@directory, '.env')
    @identities = File.join(@directory, 'identities.json')
    @tenants = %w[saas new_academy legacy_academy].each_with_index.map do |key, index|
      { 'key' => key, 'accountId' => index + 10, 'inboxId' => index + 30,
        'agentBotToken' => "synthetic-agent-token-for-#{key}", 'handoffAssigneeId' => index + 900,
        'custom' => { 'kept' => true } }
    end
    @live_tenants = @tenants.map { |entry| entry.merge('handoffAssigneeId' => 999, 'inboxId' => 88, 'liveOnly' => 'preserve') }
    File.write(@runtime, JSON.generate(@tenants))
    File.write(@env, "AUTO_SEND_ENABLED=false\nINTERN_SSO_RETURN_PATH=/app/accounts/10/inbox/88\nTENANTS_JSON='#{JSON.generate(@live_tenants)}'\nUNRELATED=kept\n")
    File.write(@identities, JSON.generate({ runtimeSha256: Digest::SHA256.hexdigest(File.read(@runtime)), identities: @tenants.map.with_index { |entry, index| entry.slice('key', 'accountId').merge('agentBotId' => index + 20) } }))
    @script = File.expand_path('../scripts/pin-learning-source-metadata.rb', __dir__)
  end

  def teardown
    FileUtils.remove_entry(@directory)
  end

  def test_adds_only_bot_ids_and_preserves_distinct_live_settings_and_sso_route
    _stdout, stderr, status = Open3.capture3(RbConfig.ruby, @script, @runtime, @env, @identities)
    assert status.success?, stderr
    runtime = JSON.parse(File.read(@runtime))
    live_line = File.readlines(@env).find { |line| line.start_with?('TENANTS_JSON=') }
    live = JSON.parse(live_line.strip.delete_prefix("TENANTS_JSON='").delete_suffix("'"))
    assert_equal @tenants, runtime.map { |entry| entry.reject { |key, _| key == 'agentBotId' } }
    assert_equal @live_tenants, live.map { |entry| entry.reject { |key, _| key == 'agentBotId' } }
    assert_equal [20, 21, 22], live.map { |entry| entry.fetch('agentBotId') }
    assert_includes File.read(@env), 'INTERN_SSO_RETURN_PATH=/app/accounts/10/inbox/88'
    assert_includes File.read(@env), 'AUTO_SEND_ENABLED=false'
    assert_includes File.read(@env), 'UNRELATED=kept'
    assert_equal 0o600, File.stat(@env).mode & 0o777
  end

  def test_rejects_mismatched_runtime_and_live_identity_before_writing_either_file
    @live_tenants.first['agentBotToken'] = 'different-synthetic-agent-token'
    File.write(@env, "TENANTS_JSON='#{JSON.generate(@live_tenants)}'\n")
    before = [File.read(@runtime), File.read(@env)]
    _stdout, stderr, status = Open3.capture3(RbConfig.ruby, @script, @runtime, @env, @identities)
    refute status.success?
    assert_equal before, [File.read(@runtime), File.read(@env)]
    refute_includes stderr, 'different-synthetic-agent-token'
  end

  def test_rejects_changed_pinned_identity_before_writing
    @tenants.first['agentBotId'] = 999
    File.write(@runtime, JSON.generate(@tenants))
    metadata = JSON.parse(File.read(@identities))
    metadata['runtimeSha256'] = Digest::SHA256.hexdigest(File.read(@runtime))
    File.write(@identities, JSON.generate(metadata))
    before = [File.read(@runtime), File.read(@env)]
    _stdout, _stderr, status = Open3.capture3(RbConfig.ruby, @script, @runtime, @env, @identities)
    refute status.success?
    assert_equal before, [File.read(@runtime), File.read(@env)]
  end
end
