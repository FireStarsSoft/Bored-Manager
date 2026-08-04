#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR

evidence_root="${BM_GATE_EVIDENCE_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p -- "$evidence_root"
evidence_dir="$(mktemp -d "${evidence_root%/}/bored-manager-feasibility.XXXXXXXX")"
chmod 0700 "$evidence_dir"
export BM_GATE_EVIDENCE_DIR="$evidence_dir"

status_file="${evidence_dir}/status.txt"
printf 'BLOCKED\n' >"$status_file"

[[ -r /etc/os-release ]] || {
  printf 'feasibility-gates: BLOCKED: /etc/os-release is missing\n' >&2
  exit 1
}
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == 'ubuntu' && "${VERSION_ID:-}" == '24.04' ]] || {
  printf 'feasibility-gates: BLOCKED: Ubuntu 24.04 is required\n' >&2
  exit 1
}
[[ "$(uname -m)" == 'x86_64' ]] || {
  printf 'feasibility-gates: BLOCKED: amd64/x86_64 is required\n' >&2
  exit 1
}
[[ -d /run/systemd/system && -f /sys/fs/cgroup/cgroup.controllers ]] || {
  printf 'feasibility-gates: BLOCKED: running systemd and cgroup v2 are required\n' >&2
  exit 1
}
command -v docker >/dev/null 2>&1 || {
  printf 'feasibility-gates: BLOCKED: Docker CLI is required in the certification lab\n' >&2
  exit 1
}
docker info >"${evidence_dir}/docker-info.txt"
security_options="$(docker info --format '{{json .SecurityOptions}}')"
[[ "$security_options" != *rootless* ]] || {
  printf 'feasibility-gates: BLOCKED: rootless Docker is not a certified v1 target\n' >&2
  exit 1
}

{
  printf 'utc_started=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'os=%s %s\n' "$ID" "$VERSION_ID"
  printf 'architecture=%s\n' "$(uname -m)"
  printf 'kernel=%s\n' "$(uname -r)"
  printf 'docker_server=%s\n' "$(docker version --format '{{.Server.Version}}')"
  printf 'cgroup_version=2\n'
} >"${evidence_dir}/host-inventory.txt"

bash "${SCRIPT_DIR}/policy-check.sh" 2>&1 | tee "${evidence_dir}/policy-check.log"
bash "${SCRIPT_DIR}/systemd-container.sh" 2>&1 | tee "${evidence_dir}/systemd-container.log"
bash "${SCRIPT_DIR}/dhcp-plugin.sh" 2>&1 | tee "${evidence_dir}/dhcp-plugin.log"

printf 'PASS\n' >"$status_file"
printf 'utc_completed=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >>"${evidence_dir}/host-inventory.txt"
(
  cd -- "$evidence_dir"
  sha256sum -- * >SHA256SUMS
)
printf 'feasibility-gates: PASS; evidence: %s\n' "$evidence_dir"
