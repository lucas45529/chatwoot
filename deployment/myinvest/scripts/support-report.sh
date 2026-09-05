#!/usr/bin/env bash
# Aggregate-only weekly report. Database credentials stay in the running agent.
set -Eeuo pipefail
umask 077

cd "$(dirname "$0")/.."
report_dir="$HOME/support-reports"
mkdir -p "$report_dir"
chmod 700 "$report_dir"
report_path="$report_dir/$(date +%G-W%V).txt"
temporary="$(mktemp "$report_dir/.support-report.XXXXXX")"
trap 'rm -f "$temporary"' EXIT

# stdin carries source only; pg reads connection strings from container env.
# Suppress raw Docker/driver diagnostics, which can include secret values.
if ! docker compose exec -T claude-agent node --input-type=commonjs - \
  < scripts/support-report.cjs > "$temporary" 2>/dev/null; then
  printf 'Support report failed; previous report preserved. Check agent/database health.\n' >&2
  exit 1
fi
chmod 600 "$temporary"
mv -f "$temporary" "$report_path"
printf 'Report: %s\n' "$report_path"
