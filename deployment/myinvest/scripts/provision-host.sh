#!/usr/bin/env bash
# Provision the dedicated production host for the MyInvest Support Platform and
# install the pinned Chatwoot stack on it.
#
#   scripts/provision-host.sh user-data   render cloud-init.yaml with the operator SSH key
#   scripts/provision-host.sh create      create (or reuse) the Hetzner Cloud server, print its IPv4
#   scripts/provision-host.sh wait        block until cloud-init finished and Docker answers
#   scripts/provision-host.sh dns         point the support hostname at the server (Cloudflare, DNS only)
#   scripts/provision-host.sh install     clone the pinned revision, upload .env, build, prepare, bootstrap, smoke
#   scripts/provision-host.sh verify      run smoke and the production E2E on the host
#   scripts/provision-host.sh status      public health check of the support hostname
#
# Inputs (environment):
#   HCLOUD_TOKEN            Hetzner Cloud API token (create, wait without SUPPORT_HOST)
#   CLOUDFLARE_API_TOKEN    zone DNS edit token for the support zone (dns)
#   PRODUCTION_ENV_FILE     validated production .env to upload (install); never committed
#   SSH_PROXY_COMMAND       optional OpenSSH ProxyCommand (for example, GCP IAP)
#   RCLONE_CONFIG_FILE      optional rclone.conf holding the BACKUP_OFFSITE_REMOTE remote (install)
#   SUPPORT_HOST            SSH target; defaults to the IPv4 recorded by `create`
#   SUPPORT_HOSTNAME        public hostname, default support.myinvest-pro.de
#   REVISION                git revision to deploy, default HEAD of this checkout (must be pushed)
#
# Secrets are read from the environment or files only and are never printed.
set -Eeuo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repository_root="$(git -C "$deployment_dir" rev-parse --show-toplevel)"

SUPPORT_HOSTNAME="${SUPPORT_HOSTNAME:-support.myinvest-pro.de}"
HCLOUD_SERVER_NAME="${HCLOUD_SERVER_NAME:-myinvest-support}"
HCLOUD_SERVER_TYPE="${HCLOUD_SERVER_TYPE:-cpx31}"
HCLOUD_LOCATION="${HCLOUD_LOCATION:-nbg1}"
HCLOUD_IMAGE="${HCLOUD_IMAGE:-ubuntu-24.04}"
HCLOUD_SSH_KEY_NAME="${HCLOUD_SSH_KEY_NAME:-myinvest-support-operator}"
SSH_PUBLIC_KEY_FILE="${SSH_PUBLIC_KEY_FILE:-$HOME/.ssh/id_ed25519.pub}"
REMOTE_USER="${REMOTE_USER:-deploy}"
SSH_PROXY_COMMAND="${SSH_PROXY_COMMAND:-}"
REMOTE_DIR="${REMOTE_DIR:-/opt/myinvest-support}"
REPOSITORY_URL="${REPOSITORY_URL:-$(git -C "$repository_root" remote get-url origin)}"
REVISION="${REVISION:-$(git -C "$repository_root" rev-parse HEAD)}"
host_record="$deployment_dir/runtime/host.json"
hcloud_api='https://api.hetzner.cloud/v1'
cloudflare_api='https://api.cloudflare.com/client/v4'
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

hcloud() {
  # $1 method, $2 path, $3 optional JSON body
  [[ -n "${HCLOUD_TOKEN:-}" ]] || fail 'HCLOUD_TOKEN is required'
  local method="$1" path="$2" body="${3:-}"
  local -a curl_args=(-fsS -X "$method" -H 'Content-Type: application/json' "$hcloud_api$path")
  [[ -z "$body" ]] || curl_args+=(--data-binary "$body")
  # The token travels through the header file, not the process list.
  curl "${curl_args[@]}" -H @<(printf 'Authorization: Bearer %s\n' "$HCLOUD_TOKEN")
}

cloudflare() {
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || fail 'CLOUDFLARE_API_TOKEN is required'
  local method="$1" path="$2" body="${3:-}"
  local -a curl_args=(-fsS -X "$method" -H 'Content-Type: application/json' "$cloudflare_api$path")
  [[ -z "$body" ]] || curl_args+=(--data-binary "$body")
  curl "${curl_args[@]}" -H @<(printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN")
}

ssh_public_key() {
  [[ -r "$SSH_PUBLIC_KEY_FILE" ]] || fail "SSH public key not found: $SSH_PUBLIC_KEY_FILE"
  local key
  key="$(tr -d '\r\n' <"$SSH_PUBLIC_KEY_FILE")"
  [[ "$key" =~ ^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa)\ [A-Za-z0-9+/=]+( [^[:space:]]+)?$ ]] ||
    fail "Unsupported SSH public key format in $SSH_PUBLIC_KEY_FILE"
  printf '%s' "$key"
}

render_user_data() {
  local template key
  template="$(<"$deployment_dir/cloud-init.yaml")"
  key="$(ssh_public_key)"
  printf '%s\n' "${template//__SSH_PUBLIC_KEY__/$key}"
}

resolve_host() {
  if [[ -n "${SUPPORT_HOST:-}" ]]; then
    printf '%s' "$SUPPORT_HOST"
  elif [[ -r "$host_record" ]]; then
    jq -er '.ipv4' "$host_record"
  else
    fail "No host known: set SUPPORT_HOST or run '$0 create' first"
  fi
}

remote() {
  # remote <host> [ssh options...] -- command...
  local host="$1"
  shift
  ssh "${ssh_options[@]}" "$REMOTE_USER@$host" "$@"
}

command_user_data() {
  render_user_data
}

command_create() {
  require_command jq
  require_command curl
  [[ -n "${HCLOUD_TOKEN:-}" ]] || fail 'HCLOUD_TOKEN is required'
  local key fingerprint ssh_key_id server user_data payload server_id ipv4 ipv6 status

  key="$(ssh_public_key)"
  fingerprint="$(ssh-keygen -l -E md5 -f "$SSH_PUBLIC_KEY_FILE" | awk '{sub(/^MD5:/, "", $2); print $2}')"
  ssh_key_id="$(hcloud GET "/ssh_keys?fingerprint=$fingerprint" | jq -r '.ssh_keys[0].id // empty')"
  if [[ -z "$ssh_key_id" ]]; then
    ssh_key_id="$(hcloud POST /ssh_keys "$(jq -cn --arg name "$HCLOUD_SSH_KEY_NAME" --arg key "$key" \
      '{name: $name, public_key: $key, labels: {project: "myinvest-support"}}')" | jq -er '.ssh_key.id')"
  fi

  server="$(hcloud GET "/servers?name=$HCLOUD_SERVER_NAME" | jq -c '.servers[0] // empty')"
  if [[ -z "$server" ]]; then
    user_data="$(render_user_data)"
    payload="$(jq -cn \
      --arg name "$HCLOUD_SERVER_NAME" \
      --arg type "$HCLOUD_SERVER_TYPE" \
      --arg image "$HCLOUD_IMAGE" \
      --arg location "$HCLOUD_LOCATION" \
      --arg user_data "$user_data" \
      --argjson ssh_key "$ssh_key_id" \
      '{name: $name, server_type: $type, image: $image, location: $location,
        ssh_keys: [$ssh_key], user_data: $user_data, start_after_create: true,
        public_net: {enable_ipv4: true, enable_ipv6: true},
        labels: {project: "myinvest-support", role: "chatwoot"}}')"
    server="$(hcloud POST /servers "$payload" | jq -c '.server')"
  fi
  server_id="$(jq -er '.id' <<<"$server")"

  # The API answers before the server runs; poll until it does.
  for _ in $(seq 1 60); do
    server="$(hcloud GET "/servers/$server_id" | jq -c '.server')"
    status="$(jq -er '.status' <<<"$server")"
    [[ "$status" == running ]] && break
    sleep 5
  done
  [[ "$status" == running ]] || fail "Server $HCLOUD_SERVER_NAME is not running (status: $status)"

  ipv4="$(jq -er '.public_net.ipv4.ip' <<<"$server")"
  ipv6="$(jq -r '.public_net.ipv6.ip // empty' <<<"$server")"
  umask 077
  jq -n --argjson id "$server_id" --arg name "$HCLOUD_SERVER_NAME" --arg ipv4 "$ipv4" --arg ipv6 "$ipv6" \
    --arg type "$HCLOUD_SERVER_TYPE" --arg location "$HCLOUD_LOCATION" --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{id: $id, name: $name, ipv4: $ipv4, ipv6: $ipv6, server_type: $type, location: $location, recorded_at: $created}' \
    >"$host_record"
  printf '%s\n' "$ipv4"
}

command_wait() {
  local host deadline
  host="$(resolve_host)"
  deadline=$((SECONDS + ${HOST_READY_TIMEOUT_SECONDS:-900}))
  until remote "$host" -- 'cloud-init status --wait >/dev/null 2>&1 && docker info >/dev/null 2>&1' 2>/dev/null; do
    (( SECONDS < deadline )) || fail "Host $host did not become ready in time"
    sleep 15
  done
  remote "$host" -- 'printf "%s docker=%s compose=%s\n" "$(hostname)" "$(docker version --format "{{.Server.Version}}")" "$(docker compose version --short)"'
}

command_dns() {
  require_command jq
  require_command curl
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || fail 'CLOUDFLARE_API_TOKEN is required'
  local host zone zone_id records record_id payload
  host="$(resolve_host)"
  zone="${SUPPORT_HOSTNAME#*.}"
  zone_id="$(cloudflare GET "/zones?name=$zone&status=active" | jq -er '.result[0].id')"
  records="$(cloudflare GET "/zones/$zone_id/dns_records?name=$SUPPORT_HOSTNAME" | jq -c '.result')"

  # A CNAME cannot coexist with the A record; the old Vercel alias goes first.
  for record_id in $(jq -r '.[] | select(.type != "A") | .id' <<<"$records"); do
    cloudflare DELETE "/zones/$zone_id/dns_records/$record_id" >/dev/null
  done

  payload="$(jq -cn --arg name "$SUPPORT_HOSTNAME" --arg content "$host" \
    '{type: "A", name: $name, content: $content, ttl: 300, proxied: false,
      comment: "MyInvest Support Platform (Caddy terminates TLS via ACME; keep DNS only)"}')"
  record_id="$(jq -r '.[] | select(.type == "A") | .id' <<<"$records" | head -n 1)"
  if [[ -n "$record_id" ]]; then
    cloudflare PUT "/zones/$zone_id/dns_records/$record_id" "$payload" >/dev/null
  else
    cloudflare POST "/zones/$zone_id/dns_records" "$payload" >/dev/null
  fi
  printf '%s A %s (DNS only, TTL 300)\n' "$SUPPORT_HOSTNAME" "$host"
}

command_install() {
  local host env_file rclone_file recovery_key
  host="$(resolve_host)"
  env_file="${PRODUCTION_ENV_FILE:-}"
  [[ -n "$env_file" && -r "$env_file" ]] || fail 'PRODUCTION_ENV_FILE must point at a readable production .env'
  grep -Eq '^LOCAL_SMOKE=false$' "$env_file" || fail 'The production .env must set LOCAL_SMOKE=false'
  grep -Eq "^CADDY_SITE_ADDRESS=$SUPPORT_HOSTNAME\$" "$env_file" ||
    fail "The production .env must set CADDY_SITE_ADDRESS=$SUPPORT_HOSTNAME"
  git -C "$repository_root" cat-file -e "$REVISION^{commit}" || fail "Unknown revision: $REVISION"
  git -C "$repository_root" branch -r --contains "$REVISION" | grep -q . ||
    fail "Revision $REVISION is not on any remote branch; push it first"

  recovery_key="$(awk -F= '/^BACKUP_GPG_RECIPIENT=/ {print $2}' "$env_file" | tail -n 1)"
  if [[ -n "$recovery_key" ]]; then
    gpg --batch --list-keys "$recovery_key" >/dev/null 2>&1 || fail "Recovery key not in local keyring: $recovery_key"
    # Encryption needs only the public recovery key on the host; the private key stays offline.
    gpg --batch --export --armor "$recovery_key" | remote "$host" -- 'gpg --batch --import >/dev/null 2>&1'
  fi

  remote "$host" -- "install -d -m 0700 '$REMOTE_DIR/incoming'"
  scp -q "${ssh_options[@]}" "$env_file" "$REMOTE_USER@$host:$REMOTE_DIR/incoming/env"
  rclone_file="${RCLONE_CONFIG_FILE:-}"
  if [[ -n "$rclone_file" ]]; then
    [[ -r "$rclone_file" ]] || fail "RCLONE_CONFIG_FILE is not readable: $rclone_file"
    scp -q "${ssh_options[@]}" "$rclone_file" "$REMOTE_USER@$host:$REMOTE_DIR/incoming/rclone.conf"
  fi
  scp -q "${ssh_options[@]}" "$deployment_dir/compose.yaml" "$REMOTE_USER@$host:$REMOTE_DIR/incoming/compose.yaml"
  scp -q "${ssh_options[@]}" "$deployment_dir/scripts/validate.sh" "$REMOTE_USER@$host:$REMOTE_DIR/incoming/validate.sh"

  remote "$host" -- bash -s -- "$REMOTE_DIR" "$REPOSITORY_URL" "$REVISION" <<'REMOTE'
set -Eeuo pipefail
remote_dir="$1" repository_url="$2" revision="$3"
source_dir="$remote_dir/src"
deployment="$source_dir/deployment/myinvest"

if [[ ! -d "$source_dir/.git" ]]; then
  git clone --quiet "$repository_url" "$source_dir"
elif [[ -n "$(git -C "$source_dir" status --porcelain --untracked-files=all)" ]]; then
  # A prior emergency repair may have left the checkout dirty. Build a clean,
  # pinned release beside it and swap paths only after the checkout is ready;
  # the running containers retain their existing bind mounts until recreation.
  releases_dir="$remote_dir/releases"
  candidate_dir="$releases_dir/src-$revision-$$"
  previous_source_dir="$releases_dir/previous-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  install -d -m 0700 "$releases_dir"
  cleanup_candidate() {
    [[ ! -e "$candidate_dir" ]] || find "$candidate_dir" -depth -delete
  }
  trap cleanup_candidate EXIT
  git clone --quiet --no-checkout "$repository_url" "$candidate_dir"
  git -C "$candidate_dir" fetch --quiet origin "$revision"
  git -C "$candidate_dir" checkout --quiet --detach "$revision"
  if [[ -d "$source_dir/deployment/myinvest/runtime" ]]; then
    install -d -m 0700 "$candidate_dir/deployment/myinvest/runtime"
    sudo -n cp -a "$source_dir/deployment/myinvest/runtime/." "$candidate_dir/deployment/myinvest/runtime/"
    sudo -n chown -R "$(id -u):$(id -g)" "$candidate_dir/deployment/myinvest/runtime"
  fi
  mv "$source_dir" "$previous_source_dir"
  if ! mv "$candidate_dir" "$source_dir"; then
    mv "$previous_source_dir" "$source_dir"
    exit 1
  fi
  candidate_dir=''
  trap - EXIT
fi
git -C "$source_dir" fetch --quiet origin "$revision"
git -C "$source_dir" checkout --quiet --detach "$revision"
install -m 0644 "$remote_dir/incoming/compose.yaml" "$deployment/compose.yaml"
install -m 0755 "$remote_dir/incoming/validate.sh" "$deployment/scripts/validate.sh"

install -m 0600 "$remote_dir/incoming/env" "$deployment/.env"
if [[ -f "$remote_dir/incoming/rclone.conf" ]]; then
  install -d -m 0700 "$HOME/.config/rclone"
  install -m 0600 "$remote_dir/incoming/rclone.conf" "$HOME/.config/rclone/rclone.conf"
fi
rm -rf "$remote_dir/incoming"

# Backups are signed by a host-local origin key so a tampered receipt is detectable
# on the recovery host. Generate it once and record its fingerprint in .env.
if ! grep -Eq '^BACKUP_GPG_SIGNING_KEY=.+$' "$deployment/.env"; then
  origin_uid='MyInvest Chatwoot Backup Origin <backup-origin@myinvest-pro.de>'
  fingerprint="$(gpg --batch --list-secret-keys --with-colons "$origin_uid" 2>/dev/null | awk -F: '/^fpr/ {print $10; exit}')"
  if [[ -z "$fingerprint" ]]; then
    gpg --batch --yes --pinentry-mode loopback --passphrase '' --quick-generate-key "$origin_uid" ed25519 sign never
    fingerprint="$(gpg --batch --list-secret-keys --with-colons "$origin_uid" | awk -F: '/^fpr/ {print $10; exit}')"
  fi
  sed -i "s/^BACKUP_GPG_SIGNING_KEY=.*$/BACKUP_GPG_SIGNING_KEY=$fingerprint/" "$deployment/.env"
  printf 'Backup origin signing key: %s (pin as BACKUP_GPG_SIGNER_FINGERPRINT on the recovery host)\n' "$fingerprint"
fi

cd "$deployment"
export CHATWOOT_BUILD_GIT_SHA="$(git -C "$source_dir" rev-parse --verify HEAD)"
docker compose --env-file .env -f compose.yaml build --pull rails claude-agent
./scripts/prepare.sh </dev/null
./scripts/bootstrap.sh </dev/null
./scripts/smoke.sh </dev/null

# Nightly application-consistent backup with offsite copy; the script serialises itself.
crontab -l 2>/dev/null | grep -v 'scripts/backup.sh' >"$HOME/.crontab.new" || true
printf '15 2 * * * cd %s && ./scripts/backup.sh >>%s/backup.log 2>&1\n' "$deployment" "$remote_dir" >>"$HOME/.crontab.new"
crontab "$HOME/.crontab.new"
rm -f "$HOME/.crontab.new"
printf 'Installed %s at %s\n' "$revision" "$deployment"
REMOTE
}

command_verify() {
  local host
  host="$(resolve_host)"
  remote "$host" -- bash -s -- "$REMOTE_DIR/src/deployment/myinvest" "$SUPPORT_HOSTNAME" <<'REMOTE'
set -Eeuo pipefail
cd "$1"
./scripts/smoke.sh </dev/null
PRODUCTION_E2E_CONFIRMATION="test:$2" ./scripts/e2e-production.sh </dev/null
REMOTE
}

command_status() {
  require_command curl
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://$SUPPORT_HOSTNAME/health")"
  printf 'https://%s/health -> %s\n' "$SUPPORT_HOSTNAME" "$code"
  [[ "$code" == 200 ]]
}

case "${1:-}" in
  user-data) command_user_data ;;
  create) command_create ;;
  wait) command_wait ;;
  dns) command_dns ;;
  install) command_install ;;
  verify) command_verify ;;
  status) command_status ;;
  *)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
