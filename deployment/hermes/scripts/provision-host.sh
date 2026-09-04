#!/usr/bin/env bash
# Provision and deploy the DGX-free MyInvest Hermes runtime to an existing host.
set -Eeuo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_HOST="${HERMES_HOST:-}"
REMOTE_USER="${REMOTE_USER:-deploy}"
REMOTE_DIR="${REMOTE_DIR:-/opt/hermes-stack}"
SSH_PUBLIC_KEY_FILE="${SSH_PUBLIC_KEY_FILE:-$HOME/.ssh/id_ed25519.pub}"
SSH_PROXY_COMMAND="${SSH_PROXY_COMMAND:-}"
HERMES_DATA_SOURCE="${HERMES_DATA_SOURCE:-$HOME/.hermes}"
MEMORY_SOURCE="${MEMORY_SOURCE:-$HOME/.claude/memory-mcp}"
MEMORY_TOKEN_FILE="${MEMORY_TOKEN_FILE:-$HOME/.memory-bridge-token}"
HERMES_DASHBOARD_CREDENTIALS_FILE="${HERMES_DASHBOARD_CREDENTIALS_FILE:-$HOME/.config/myinvest-support/hermes-dashboard-credentials.json}"
HERMES_AUTH_FILE="${HERMES_AUTH_FILE:-$HERMES_DATA_SOURCE/auth.json}"
HERMES_REPOSITORY_URL="${HERMES_REPOSITORY_URL:-https://github.com/NousResearch/hermes-agent.git}"
HERMES_REVISION="${HERMES_REVISION:-a871948d8d4b0f774d4ec40467bab1078a9f28d5}"
SYNC_MEMORY_STATE="${SYNC_MEMORY_STATE:-true}"
ssh_options=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o StrictHostKeyChecking=accept-new)
if [[ -n "$SSH_PROXY_COMMAND" ]]; then
  ssh_options+=(-o "ProxyCommand=$SSH_PROXY_COMMAND")
fi


fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

require_host() {
  [[ -n "$HERMES_HOST" ]] || fail "HERMES_HOST is required"
}

remote() {
  ssh "${ssh_options[@]}" "$REMOTE_USER@$HERMES_HOST" "$@"
}

ssh_public_key() {
  [[ -r "$SSH_PUBLIC_KEY_FILE" ]] || fail "SSH public key not found: $SSH_PUBLIC_KEY_FILE"
  local key
  key="$(tr -d '\r\n' <"$SSH_PUBLIC_KEY_FILE")"
  [[ "$key" =~ ^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa)\ [A-Za-z0-9+/=]+(\ [^[:space:]]+)?$ ]] ||
    fail "Unsupported SSH public key format in $SSH_PUBLIC_KEY_FILE"
  printf '%s' "$key"
}
write_rsync_ssh_wrapper() {
  local destination="$1"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf 'exec ssh'
    printf ' %q' "${ssh_options[@]}"
    printf ' "$@"\n'
  } >"$destination"
  chmod 0700 "$destination"
}

command_user_data() {
  local template key
  template="$(<"$deployment_dir/cloud-init.yaml")"
  key="$(ssh_public_key)"
  printf '%s\n' "${template//__SSH_PUBLIC_KEY__/$key}"
}

command_wait() {
  require_host
  local deadline
  deadline=$((SECONDS + ${HOST_READY_TIMEOUT_SECONDS:-1200}))
  until remote -- 'cloud-init status --wait >/dev/null 2>&1 && docker info >/dev/null 2>&1'; do
    (( SECONDS < deadline )) || fail "Host $HERMES_HOST did not become ready in time"
    sleep 15
  done
  remote -- 'printf "%s docker=%s compose=%s\n" "$(hostname)" "$(docker version --format "{{.Server.Version}}")" "$(docker compose version --short)"'
}

stage_server_state() {
  local destination="$1"
  require_command python3
  [[ -r "$HERMES_DATA_SOURCE/config.yaml" ]] || fail "Hermes config missing: $HERMES_DATA_SOURCE/config.yaml"
  [[ -r "$HERMES_DATA_SOURCE/.env" ]] || fail "Hermes env missing: $HERMES_DATA_SOURCE/.env"
  python3 "$deployment_dir/scripts/render-server-state.py" \
    --source "$HERMES_DATA_SOURCE" \
    --output "$destination" \
    --dashboard-credentials "$HERMES_DASHBOARD_CREDENTIALS_FILE"
}

command_install() {
  require_host
  require_command rsync
  require_command scp
  require_command ssh
  [[ -d "$MEMORY_SOURCE/src" ]] || fail "Memory source missing: $MEMORY_SOURCE"
  [[ -s "$MEMORY_TOKEN_FILE" ]] || fail "Memory bridge token missing: $MEMORY_TOKEN_FILE"
  [[ -s "$HERMES_DASHBOARD_CREDENTIALS_FILE" ]] ||
    fail "Hermes dashboard credentials missing: $HERMES_DASHBOARD_CREDENTIALS_FILE"
  [[ -s "$HERMES_AUTH_FILE" ]] || fail "Hermes auth file missing: $HERMES_AUTH_FILE"
  [[ "$SYNC_MEMORY_STATE" == true || "$SYNC_MEMORY_STATE" == false ]] ||
    fail "SYNC_MEMORY_STATE must be true or false"

  stage="$(mktemp -d)"
  trap 'rm -rf "$stage"' EXIT
  write_rsync_ssh_wrapper "$stage/rsync-ssh"
  stage_server_state "$stage/hermes"
  remote -- "sudo install -d -m 0750 '$REMOTE_DIR' '$REMOTE_DIR/secrets' '$REMOTE_DIR/data/hermes' '$REMOTE_DIR/data/memory' '$REMOTE_DIR/memory-mcp' && sudo chown -R \"\$(id -u):\$(id -g)\" '$REMOTE_DIR/secrets' '$REMOTE_DIR/data/hermes' '$REMOTE_DIR/data/memory' '$REMOTE_DIR/memory-mcp'"
  scp -q "${ssh_options[@]}" \
    "$deployment_dir/compose.yaml" "$deployment_dir/Dockerfile.memory" \
    "$REMOTE_USER@$HERMES_HOST:$REMOTE_DIR/"
  rsync -az --delete --exclude='auth.json' -e "$stage/rsync-ssh" \
    "$stage/hermes/" "$REMOTE_USER@$HERMES_HOST:$REMOTE_DIR/data/hermes/"
  if ! remote -- "sudo python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); sys.exit(0 if data.get(\"credential_pool\", {}).get(\"openrouter\") else 1)' '$REMOTE_DIR/data/hermes/auth.json' 2>/dev/null"; then
    scp -q "${ssh_options[@]}" \
      "$HERMES_AUTH_FILE" "$REMOTE_USER@$HERMES_HOST:$REMOTE_DIR/data/hermes/auth.json"
  fi
  remote -- "chmod 0600 '$REMOTE_DIR/data/hermes/auth.json'"
  scp -q "${ssh_options[@]}" \
    "$stage/hermes/.env" "$REMOTE_USER@$HERMES_HOST:$REMOTE_DIR/secrets/hermes.env"
  scp -q "${ssh_options[@]}" \
    "$MEMORY_TOKEN_FILE" "$REMOTE_USER@$HERMES_HOST:$REMOTE_DIR/secrets/memory_http_token"

  rsync -az --delete \
    --exclude='.backup/' --exclude='.git/' --exclude='.recovery/' --exclude='.state/' \
    --exclude='dist.bak-*/' --exclude='node_modules/' --exclude='*.log' \
    -e "$stage/rsync-ssh" \
    "$MEMORY_SOURCE/" "$REMOTE_USER@$HERMES_HOST:$REMOTE_DIR/memory-mcp/"

  if [[ "$SYNC_MEMORY_STATE" == true ]]; then
    remote -- "install -d -m 0700 '$REMOTE_DIR/data/memory/.state'"
    rsync -az --delete --partial \
      --exclude='*.log' --exclude='*.lock' --exclude='*-shm' --exclude='*-wal' \
      --exclude='.local-store.lock/' --exclude='.*token*' \
      -e "$stage/rsync-ssh" \
      "$MEMORY_SOURCE/.state/" "$REMOTE_USER@$HERMES_HOST:$REMOTE_DIR/data/memory/.state/"
  fi

  remote -- bash -s -- "$REMOTE_DIR" "$HERMES_REPOSITORY_URL" "$HERMES_REVISION" <<'REMOTE'
set -Eeuo pipefail
remote_dir="$1"
repository_url="$2"
revision="$3"
cd "$remote_dir"
if [[ ! -d hermes-agent/.git ]]; then
  git clone --filter=blob:none "$repository_url" hermes-agent
fi
git -C hermes-agent fetch --depth=1 origin "$revision"
git -C hermes-agent checkout --detach "$revision"
sudo rm -f data/memory/.state/.stripe-token data/memory/.state/.stripe-token-2 data/memory/.state/.hubspot-token
sudo chown -R 10000:10000 data/hermes data/memory
sudo chown "$(id -u):$(id -g)" secrets secrets/hermes.env
sudo chown 10000:10000 secrets/memory_http_token
sudo chmod 0700 data/hermes data/memory secrets
sudo chmod 0600 secrets/hermes.env secrets/memory_http_token data/hermes/.env data/hermes/config.yaml
docker compose pull ollama
docker compose build memory gateway
docker compose up -d ollama
for _ in $(seq 1 60); do
  [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' myinvest-hermes-ollama-1 2>/dev/null)" == healthy ]] && break
  sleep 5
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' myinvest-hermes-ollama-1)" == healthy ]]
egress_network=myinvest-hermes-model-pull
docker network disconnect --force "$egress_network" myinvest-hermes-ollama-1 >/dev/null 2>&1 || true
docker network rm "$egress_network" >/dev/null 2>&1 || true
docker network create --driver bridge "$egress_network" >/dev/null
docker network connect "$egress_network" myinvest-hermes-ollama-1
remove_ollama_egress() {
  docker network disconnect --force "$egress_network" myinvest-hermes-ollama-1 >/dev/null 2>&1 || true
  docker network rm "$egress_network" >/dev/null 2>&1 || true
}
trap remove_ollama_egress EXIT
docker compose exec -T ollama ollama pull bge-m3 </dev/null
remove_ollama_egress
trap - EXIT
docker compose up -d --force-recreate --wait --wait-timeout 600 memory
docker compose up -d --force-recreate --remove-orphans --wait --wait-timeout 600 gateway
REMOTE

  command_verify
}

command_verify() {
  require_host
  remote -- bash -s -- "$REMOTE_DIR" <<'REMOTE'
set -Eeuo pipefail
cd "$1"
deadline=$((SECONDS + 600))
for service in ollama memory gateway; do
  container="myinvest-hermes-${service}-1"
  until [[ "$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null)" == "running healthy" ]]; do
    (( SECONDS < deadline )) || {
      docker compose ps
      printf 'Timed out waiting for %s\n' "$container" >&2
      exit 1
    }
    sleep 5
  done
done
[[ "$(docker inspect --format '{{json .NetworkSettings.Networks}}' myinvest-hermes-ollama-1 | jq -r 'keys | sort | join(",")')" == myinvest-hermes_internal ]]
curl -fsS --max-time 10 http://127.0.0.1:9119/health >/dev/null
listeners="$(ss -lntH | awk '$4 ~ /:9119$/ {print $4}')"
[[ "$listeners" == "127.0.0.1:9119" ]]
meta_rows="$(sudo python3 -c 'import sys; print(sum(1 for _ in open(sys.argv[1], encoding="utf-8")))' data/memory/.state/local-meta.jsonl)"
vector_bytes="$(sudo stat -c '%s' data/memory/.state/local-vecs.f32)"
(( vector_bytes % 4096 == 0 ))
[[ "$meta_rows" -eq $((vector_bytes / 4096)) ]]
[[ -z "$(sudo find data/memory/.state -maxdepth 1 -type f -name '.*token*' -print -quit)" ]]
! sudo grep -REqi '(^|[^a-z])dgx([^a-z]|$)|127\.0\.0\.1:8220' data/hermes/config.yaml data/hermes/profiles
[[ "$(stat -c '%a' secrets/hermes.env)" == 600 ]]
[[ "$(stat -c '%a' secrets/memory_http_token)" == 600 ]]
[[ "$(sudo stat -c '%a' data/hermes/auth.json)" == 600 ]]
[[ "$(stat -c '%u' secrets/hermes.env)" == "$(id -u)" ]]
[[ "$(stat -c '%u' secrets/memory_http_token)" == 10000 ]]
docker compose exec -T gateway node -e \
  "const fs=require('fs');const token=fs.readFileSync('/run/secrets/memory_http_token','utf8').trim();fetch('http://memory:8787/search',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({query:'deployment-health-probe',top_k:1})}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" </dev/null
docker compose exec -T gateway python -c \
  "import glob,json,yaml; jobs=json.load(open('/opt/data/cron/jobs.json'))['jobs']; auth=json.load(open('/opt/data/auth.json')); configs=[yaml.safe_load(open(path)) for path in ['/opt/data/config.yaml',*glob.glob('/opt/data/profiles/*/config.yaml')]]; assert [j['script'] for j in jobs if j.get('enabled')] == ['stripe_payment_sync.py']; assert auth.get('credential_pool', {}).get('openrouter'); assert len(configs) == 6; assert all(c['model']['provider'] == 'openrouter' and c['model']['default'] == 'nvidia/nemotron-3-ultra-550b-a55b:free' and c['model']['base_url'] == 'https://openrouter.ai/api/v1' for c in configs)" </dev/null
docker compose exec -T gateway python -c \
  "import json,os,urllib.request; assert os.environ.get('TELEGRAM_ALLOWED_USERS'); token=os.environ['TELEGRAM_BOT_TOKEN']; response=json.load(urllib.request.urlopen(f'https://api.telegram.org/bot{token}/getMe', timeout=15)); assert response.get('ok')" </dev/null
sudo ufw status | grep -q 'Status: active'
printf 'Hermes verified: containers healthy, dashboard loopback-only, memory authenticated/consistent, five profiles and portable cron active, legacy tokens absent, DGX absent, ufw active\n'
REMOTE
}

command_status() {
  require_host
  remote -- "cd '$REMOTE_DIR' && docker compose ps"
}

case "${1:-}" in
  user-data) command_user_data ;;
  wait) command_wait ;;
  install) command_install ;;
  verify) command_verify ;;
  status) command_status ;;
  *) fail "Usage: $0 {user-data|wait|install|verify|status}" ;;
esac
