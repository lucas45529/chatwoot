#!/usr/bin/env bash
set -Eeuo pipefail

spec_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deployment_dir="$(cd "$spec_dir/.." && pwd)"
compose_file="$deployment_dir/compose.yaml"
provision_script="$deployment_dir/scripts/provision-host.sh"

# Pin the immutable multi-architecture indexes in compose.yaml
grep -Fq 'minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e' "$compose_file"
grep -Fq 'minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727' "$compose_file"

# Same digests pinned in validate.sh
grep -Fq 'minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e' "$deployment_dir/scripts/validate.sh"
grep -Fq 'minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727' "$deployment_dir/scripts/validate.sh"

# The application revision is remote-pinned, so the local production compose file must be overlaid.
# Both compose.yaml and validate.sh must be staged and installed
grep -Fq '"$deployment_dir/compose.yaml" "$REMOTE_USER@$host:$REMOTE_DIR/incoming/compose.yaml"' "$provision_script"
grep -Fq '"$deployment_dir/scripts/validate.sh" "$REMOTE_USER@$host:$REMOTE_DIR/incoming/validate.sh"' "$provision_script"
grep -Fq 'install -m 0644 "$remote_dir/incoming/compose.yaml" "$deployment/compose.yaml"' "$provision_script"
grep -Fq 'install -m 0755 "$remote_dir/incoming/validate.sh" "$deployment/scripts/validate.sh"' "$provision_script"

# Dirty emergency hotfixes never block a pinned rollout or leak into it.
grep -Fq 'status --porcelain --untracked-files=all' "$provision_script"
grep -Fq 'sudo -n cp -a "$source_dir/deployment/myinvest/runtime/." "$candidate_dir/deployment/myinvest/runtime/"' "$provision_script"
grep -Fq 'sudo -n chown -R "$(id -u):$(id -g)" "$candidate_dir/deployment/myinvest/runtime"' "$provision_script"
grep -Fq 'mv "$source_dir" "$previous_source_dir"' "$provision_script"

# All five remote child script calls must prevent stdin inheritance
grep -Fq './scripts/prepare.sh </dev/null' "$provision_script"
grep -Fq './scripts/bootstrap.sh </dev/null' "$provision_script"
[[ "$(grep -Fc './scripts/smoke.sh </dev/null' "$provision_script")" -eq 2 ]] # once in install, once in verify
grep -Fq './scripts/e2e-production.sh </dev/null' "$provision_script"

printf 'Multi-architecture image pins and compose overlay verified.\n'
