#!/usr/bin/env bash
set -Eeuo pipefail

mode="${1:-dry-run}"
if (( $# > 1 )) || [[ "$mode" != "dry-run" && "$mode" != "--apply" ]]; then
  printf 'Usage: install-learning-loop.sh [--apply]\n' >&2
  exit 1
fi

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
report_dir="${HOME}/support-reports"
managed_block="# BEGIN MYINVEST REVIEWED LEARNING
47 6 * * * docker exec myinvest-chatwoot-claude-agent-1 node dist/learning/mine-cli.js --days 14 >> ${report_dir}/learning-mine.log 2>&1
12 7 * * 1 ${deployment_dir}/scripts/support-report.sh >/dev/null 2>&1
# END MYINVEST REVIEWED LEARNING"

if [[ "$mode" == "dry-run" ]]; then
  printf '%s\n' "$managed_block"
  exit 0
fi

mkdir -p -m 700 "$report_dir"
temporary="$(mktemp)"
trap 'rm -f "$temporary"' EXIT
{
  crontab -l 2>/dev/null \
    | sed '/# BEGIN MYINVEST REVIEWED LEARNING/,/# END MYINVEST REVIEWED LEARNING/d' \
    | sed '/dist\/learning\/mine-cli\.js/d' \
    | sed '/scripts\/support-report\.sh/d' || true
  printf '%s\n' "$managed_block"
} > "$temporary"
chmod 600 "$temporary"
crontab "$temporary"
printf '{"event":"reviewed_learning_schedule_installed","miner":"daily","report":"weekly"}\n'
