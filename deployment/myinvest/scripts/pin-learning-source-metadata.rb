#!/usr/bin/env ruby
# frozen_string_literal: true

require 'json'
require 'digest'

# Unlike the normal bootstrap renderer this command changes only agentBotId.
# Runtime and live env may have intentionally different inbox/assignee values.
temporary_paths = []
begin
  runtime_path, env_path, identities_path = ARGV
  raise 'Invalid arguments' unless ARGV.length == 3

  runtime_original = File.read(runtime_path)
  env_original = File.read(env_path)
  metadata = JSON.parse(File.read(identities_path))
  raise 'Stale identity metadata' unless metadata.fetch('runtimeSha256') == Digest::SHA256.hexdigest(runtime_original)

  lines = env_original.lines
  indexes = lines.each_index.select { |index| lines[index].start_with?('TENANTS_JSON=') }
  raise 'Ambiguous tenant configuration' unless indexes.one?

  index = indexes.first
  raw = lines[index].chomp.delete_prefix('TENANTS_JSON=')
  raw = raw[1...-1] if raw.start_with?("'") && raw.end_with?("'")
  raw = JSON.parse(raw) if raw.start_with?('"')
  runtime = JSON.parse(runtime_original)
  live = JSON.parse(raw)
  identities = metadata.fetch('identities')
  [runtime, live, identities].each do |entries|
    unless entries.is_a?(Array) && entries.map { |entry| entry.fetch('key') }.sort == %w[legacy_academy new_academy saas]
      raise 'Invalid tenant identities'
    end
  end

  runtime_by_key = runtime.to_h { |entry| [entry.fetch('key'), entry] }
  live_by_key = live.to_h { |entry| [entry.fetch('key'), entry] }
  identities.each do |identity|
    stored = runtime_by_key.fetch(identity.fetch('key'))
    active = live_by_key.fetch(identity.fetch('key'))
    bot_id = identity.fetch('agentBotId')
    unless bot_id.is_a?(Integer) && bot_id.positive? && bot_id <= 9_007_199_254_740_991 &&
           stored.fetch('accountId') == identity.fetch('accountId') &&
           active.fetch('accountId') == stored.fetch('accountId') &&
           active.fetch('agentBotToken') == stored.fetch('agentBotToken') &&
           [stored, active].all? { |entry| !entry.key?('agentBotId') || entry.fetch('agentBotId') == bot_id }
      raise 'Tenant identity mismatch'
    end
    stored['agentBotId'] = bot_id
    active['agentBotId'] = bot_id
  end

  json = JSON.generate(live)
  raise 'Unsupported env quoting' if json.include?("'")

  newline = lines[index].end_with?("\n") ? "\n" : ''
  lines[index] = "TENANTS_JSON='#{json}'#{newline}"
  raise 'Tenant configuration changed concurrently' unless File.read(runtime_path) == runtime_original && File.read(env_path) == env_original

  updates = { runtime_path => JSON.generate(runtime) + "\n", env_path => lines.join }
  updates.each do |path, content|
    temporary = "#{path}.learning-source.#{Process.pid}"
    File.open(temporary, File::WRONLY | File::CREAT | File::EXCL, 0o600) { |file| file.write(content) }
    temporary_paths << [temporary, path]
  end
  temporary_paths.each { |temporary, path| File.rename(temporary, path) }
  puts 'Added learning source IDs; other runtime and env values are unchanged.'
rescue StandardError
  # Parsing and lookup errors can include credential-bearing input.
  warn 'Learning source metadata validation failed; check tenant identity consistency.'
  exit 1
ensure
  temporary_paths.each { |temporary, _path| File.delete(temporary) if File.exist?(temporary) }
end
