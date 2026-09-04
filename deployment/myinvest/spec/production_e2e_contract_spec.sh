#!/usr/bin/env bash
set -Eeuo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
e2e_script="$deployment_dir/scripts/e2e-production.sh"

grep -Fq "answer_content='Wie funktioniert die Finanzierungsvermittlung?'" "$e2e_script"
grep -Fq "E2E_EXPECTED_SOURCE_URL='https://www.myinvest-pro.de/faq'" "$e2e_script"
grep -Fq 'conversation.label_list.include?("beratung")' "$e2e_script"
grep -Fq "Production E2E Recovery Registry" "$e2e_script"
grep -Fq "'\''retired'\'', false" "$e2e_script"
if grep -Fq 'draft.include?("Einstellungen")' "$e2e_script"; then
  printf 'Production E2E still depends on agent-local synthetic answer knowledge.\n' >&2
  exit 1
fi

printf 'Production E2E contract passed: website corpus source and inactive recovery marker.\n'
