require 'rails_helper'
require 'open3'
require 'tmpdir'
require 'uri'

describe 'deployment/myinvest/scripts/setup-env.sh' do
  let(:setup_script) { Rails.root.join('deployment/myinvest/scripts/setup-env.sh') }

  it 'generates a distinct read-only Chatwoot database identity without placeholders' do
    Dir.mktmpdir do |directory|
      env_path = File.join(directory, '.env')
      output, status = Open3.capture2e(setup_script.to_s, env_path)

      expect(status).to be_success, output
      values = File.readlines(env_path, chomp: true)
                   .filter_map { |line| line.split('=', 2) if line.match?(/^[A-Z0-9_]+=/) }
                   .to_h
      expect(values.values).not_to include(a_string_including('__GENERATE'))
      expect(values.fetch('AGENT_LEARNING_DATABASE_USER')).to eq('agent_learning_ro')
      expect(values.fetch('AGENT_LEARNING_DATABASE_PASSWORD')).not_to eq(values.fetch('POSTGRES_PASSWORD'))

      database_uri = URI.parse(values.fetch('AGENT_LEARNING_CHATWOOT_DATABASE_URL'))
      expect(database_uri.user).to eq('agent_learning_ro')
      expect(database_uri.password).to eq(values.fetch('AGENT_LEARNING_DATABASE_PASSWORD'))
      expect(database_uri.path).to eq('/chatwoot')
    end
  end

  it 'repairs a missing read-only URL without rotating its existing password' do
    Dir.mktmpdir do |directory|
      env_path = File.join(directory, '.env')
      initial_output, initial_status = Open3.capture2e(setup_script.to_s, env_path)
      expect(initial_status).to be_success, initial_output

      initial_values = File.readlines(env_path, chomp: true)
                           .filter_map { |line| line.split('=', 2) if line.match?(/^[A-Z0-9_]+=/) }
                           .to_h
      existing_password = initial_values.fetch('AGENT_LEARNING_DATABASE_PASSWORD')
      repaired_lines = File.readlines(env_path, chomp: true).map do |line|
        line.start_with?('AGENT_LEARNING_CHATWOOT_DATABASE_URL=') ? 'AGENT_LEARNING_CHATWOOT_DATABASE_URL=' : line
      end
      File.write(env_path, "#{repaired_lines.join("\n")}\n")

      repair_output, repair_status = Open3.capture2e(setup_script.to_s, env_path)
      expect(repair_status).to be_success, repair_output
      repaired_values = File.readlines(env_path, chomp: true)
                            .filter_map { |line| line.split('=', 2) if line.match?(/^[A-Z0-9_]+=/) }
                            .to_h
      expect(repaired_values.fetch('AGENT_LEARNING_DATABASE_PASSWORD')).to eq(existing_password)

      database_uri = URI.parse(repaired_values.fetch('AGENT_LEARNING_CHATWOOT_DATABASE_URL'))
      expect(database_uri.password).to eq(existing_password)
    end
  end
end
