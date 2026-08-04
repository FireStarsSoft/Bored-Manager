#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

image="${BM_SYSTEMD_IMAGE:-}"
evidence_dir="${BM_GATE_EVIDENCE_DIR:-}"
container_name="bm-systemd-gate-$(date -u +%Y%m%d%H%M%S)-$$"

die() {
  printf 'systemd-container-gate: BLOCKED: %s\n' "$*" >&2
  exit 1
}

[[ "$image" =~ ^[A-Za-z0-9./_-]+@sha256:[0-9a-f]{64}$ ]] || \
  die 'BM_SYSTEMD_IMAGE must be an immutable digest-pinned supported-platform image'
[[ -n "$evidence_dir" && -d "$evidence_dir" ]] || die 'BM_GATE_EVIDENCE_DIR is required'
[[ "${BM_EXPECTED_PLATFORM:-}" =~ ^(ubuntu-24\.04|kali-rolling)$ ]] || \
  die 'BM_EXPECTED_PLATFORM must be ubuntu-24.04 or kali-rolling'
command -v docker >/dev/null 2>&1 || die 'Docker CLI is required on the isolated lab host'

cleanup() {
  docker container inspect "$container_name" >"${evidence_dir}/systemd-container-final-inspect.json" \
    2>/dev/null || true
  docker container rm --force "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker image inspect "$image" >"${evidence_dir}/systemd-image-inspect.json" || \
  die 'the digest-pinned systemd image is not available'

docker run --detach --name "$container_name" \
  --cgroupns private \
  --stop-signal 'SIGRTMIN+3' \
  --tmpfs /run:rw,nosuid,nodev,mode=0755 \
  --tmpfs /run/lock:rw,nosuid,nodev,noexec,mode=0755 \
  --label io.firestarssoft.bored-manager.lab-gate=systemd \
  "$image" /sbin/init >"${evidence_dir}/systemd-container-id.txt"

ready=0
for _ in {1..30}; do
  if docker exec "$container_name" systemctl is-system-running --wait >/dev/null 2>&1; then
    ready=1
    break
  fi
  state="$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || true)"
  [[ "$state" == 'running' ]] || die "container exited while systemd was starting (${state:-unknown})"
  sleep 1
done
((ready == 1)) || die 'systemd did not become operational within 30 seconds'

docker exec "$container_name" sh -eu -c '
  test "$(cat /proc/1/comm)" = systemd
  test -f /sys/fs/cgroup/cgroup.controllers
  systemd-run --quiet --wait --collect --unit=bored-manager-feasibility /bin/true
' >"${evidence_dir}/systemd-transient-unit.log" 2>&1 || \
  die 'PID 1, cgroup v2, or transient-unit validation failed'

docker exec "$container_name" cat /etc/os-release >"${evidence_dir}/systemd-container-os-release.txt"
container_platform="$(docker exec "$container_name" sh -eu -c '
  . /etc/os-release
  case "${ID:-}:${VERSION_ID:-}:${VERSION_CODENAME:-}" in
    ubuntu:24.04:*) printf ubuntu-24.04 ;;
    kali:*:kali-rolling) printf kali-rolling ;;
    *) printf unsupported ;;
  esac
')"
[[ "$container_platform" == "$BM_EXPECTED_PLATFORM" ]] || \
  die "systemd image platform ${container_platform} does not match ${BM_EXPECTED_PLATFORM}"

docker exec "$container_name" systemctl --no-pager --failed \
  >"${evidence_dir}/systemd-failed-units.txt" 2>&1 || true
docker container inspect "$container_name" >"${evidence_dir}/systemd-container-inspect.json"
docker stop --time 30 "$container_name" >"${evidence_dir}/systemd-stop.txt"

printf 'systemd-container-gate: PASS: least-privilege systemd lifecycle completed\n'
