#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
readonly REPOSITORY_ROOT

forbidden='--privileged([=[:space:]]|$)|--cap-add(=|[[:space:]])SYS_ADMIN|apparmor[=:]unconfined|seccomp[=:]unconfined|--pid(=|[[:space:]])host|--network(=|[[:space:]])host|--cgroupns(=|[[:space:]])host|--userns(=|[[:space:]])host'

use_rg=0
if command -v rg >/dev/null 2>&1 && rg --version >/dev/null 2>&1; then
  use_rg=1
fi

matches=""
if ((use_rg == 1)); then
  matches="$(rg -n \
    --glob '*.sh' \
    --glob '*.yml' \
    --glob '*.yaml' \
    --glob '!lab/gates/policy-check.sh' \
    -- "$forbidden" \
    "${REPOSITORY_ROOT}/scripts" \
    "${REPOSITORY_ROOT}/packaging" \
    "${REPOSITORY_ROOT}/lab" \
    "${REPOSITORY_ROOT}/.github" || true)"
else
  while IFS= read -r candidate; do
    [[ "$candidate" != "${SCRIPT_DIR}/policy-check.sh" ]] || continue
    result="$(grep -En -- "$forbidden" "$candidate" || true)"
    if [[ -n "$result" ]]; then
      matches+="${candidate}:${result}"$'\n'
    fi
  done < <(find \
    "${REPOSITORY_ROOT}/scripts" \
    "${REPOSITORY_ROOT}/packaging" \
    "${REPOSITORY_ROOT}/lab" \
    "${REPOSITORY_ROOT}/.github" \
    -type f \( -name '*.sh' -o -name '*.yml' -o -name '*.yaml' \) -print)
  matches="${matches%$'\n'}"
fi

if [[ -n "$matches" ]]; then
  printf 'policy-check: forbidden container relaxation found:\n%s\n' "$matches" >&2
  exit 1
fi

if ((use_rg == 1)); then
  mapfile -t self_hosted_workflows < <(rg -l --glob '*.yml' --glob '*.yaml' \
    'runs-on:.*self-hosted|self-hosted' "${REPOSITORY_ROOT}/.github/workflows" || true)
else
  mapfile -t self_hosted_workflows < <(grep -El 'runs-on:.*self-hosted|self-hosted' \
    "${REPOSITORY_ROOT}"/.github/workflows/*.yml \
    "${REPOSITORY_ROOT}"/.github/workflows/*.yaml 2>/dev/null || true)
fi
for workflow in "${self_hosted_workflows[@]}"; do
  if grep -Eq '^[[:space:]]{0,2}pull_request:' "$workflow"; then
    printf 'policy-check: self-hosted workflow is reachable from pull_request: %s\n' "$workflow" >&2
    exit 1
  fi
done

if ((use_rg == 0)); then
  printf 'policy-check: note: rg unavailable; used grep fallback\n' >&2
fi

printf 'policy-check: least-privilege and trusted-workflow policy passed\n'
