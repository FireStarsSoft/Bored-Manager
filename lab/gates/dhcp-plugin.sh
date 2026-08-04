#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

driver="${BM_DHCP_DRIVER:-}"
plugin_id="${BM_DHCP_PLUGIN_ID:-}"
probe_image="${BM_DHCP_PROBE_IMAGE:-}"
verify_adapter="${BM_DHCP_VERIFY_ADAPTER:-}"
options_file="${BM_DHCP_OPTIONS_FILE:-}"
evidence_dir="${BM_GATE_EVIDENCE_DIR:-}"
suffix="$(date -u +%Y%m%d%H%M%S)-$$"
network_name="bm-dhcp-gate-${suffix}"
first_container="bm-dhcp-a-${suffix}"
second_container="bm-dhcp-b-${suffix}"

die() {
  printf 'dhcp-plugin-gate: BLOCKED: %s\n' "$*" >&2
  exit 1
}

[[ "$driver" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || die 'BM_DHCP_DRIVER is invalid'
[[ "$plugin_id" =~ ^[0-9a-f]{64}$ ]] || die 'BM_DHCP_PLUGIN_ID must be an exact 64-hex Docker plugin ID'
[[ "$probe_image" =~ ^[A-Za-z0-9./_-]+@sha256:[0-9a-f]{64}$ ]] || \
  die 'BM_DHCP_PROBE_IMAGE must be immutable and digest-pinned'
[[ "$verify_adapter" == /* && -x "$verify_adapter" ]] || \
  die 'BM_DHCP_VERIFY_ADAPTER must be an installed absolute executable'
[[ -n "$evidence_dir" && -d "$evidence_dir" ]] || die 'BM_GATE_EVIDENCE_DIR is required'
command -v docker >/dev/null 2>&1 || die 'Docker CLI is required on the isolated lab host'

network_options=()
if [[ -n "$options_file" ]]; then
  [[ "$options_file" == /* && -f "$options_file" && ! -L "$options_file" ]] || \
    die 'BM_DHCP_OPTIONS_FILE must be an absolute regular non-symlink file'
  while IFS= read -r option || [[ -n "$option" ]]; do
    [[ -z "$option" || "$option" == \#* ]] && continue
    [[ "$option" =~ ^[A-Za-z0-9_.-]+=[^[:cntrl:]]+$ ]] || die 'invalid DHCP network option'
    network_options+=(--opt "$option")
  done <"$options_file"
fi

cleanup() {
  docker container rm --force "$first_container" "$second_container" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

actual_plugin_id="$(docker plugin inspect --format '{{.ID}}' "$driver" 2>/dev/null || true)"
[[ "$actual_plugin_id" == "$plugin_id" ]] || die 'installed plugin identity does not match BM_DHCP_PLUGIN_ID'
[[ "$(docker plugin inspect --format '{{.Enabled}}' "$driver")" == 'true' ]] || die 'plugin is not enabled'
docker plugin inspect "$driver" >"${evidence_dir}/dhcp-plugin-inspect.json"
docker image inspect "$probe_image" >"${evidence_dir}/dhcp-probe-image-inspect.json" || \
  die 'the digest-pinned DHCP probe image is not available'

docker network create --driver "$driver" \
  --label io.firestarssoft.bored-manager.lab-gate=dhcp \
  "${network_options[@]}" "$network_name" >"${evidence_dir}/dhcp-network-id.txt"
docker network inspect "$network_name" >"${evidence_dir}/dhcp-network-inspect-created.json"

docker run --detach --name "$first_container" --network "$network_name" \
  --label io.firestarssoft.bored-manager.lab-gate=dhcp \
  "$probe_image" sh -c 'trap "exit 0" TERM INT; while :; do sleep 30; done' \
  >"${evidence_dir}/dhcp-first-container-id.txt"
first_ip="$(docker inspect --format "{{with index .NetworkSettings.Networks \"${network_name}\"}}{{.IPAddress}}{{end}}" "$first_container")"
[[ -n "$first_ip" ]] || die 'plugin did not acquire an address for the first container'
"$verify_adapter" acquire "$driver" "$plugin_id" "$network_name" "$first_container" "$first_ip" \
  >"${evidence_dir}/dhcp-acquire.txt"

docker restart --time 20 "$first_container" >/dev/null
renewed_ip="$(docker inspect --format "{{with index .NetworkSettings.Networks \"${network_name}\"}}{{.IPAddress}}{{end}}" "$first_container")"
[[ -n "$renewed_ip" ]] || die 'address disappeared after the renewal/restart check'
"$verify_adapter" renew "$driver" "$plugin_id" "$network_name" "$first_container" "$renewed_ip" \
  >"${evidence_dir}/dhcp-renew.txt"

docker container rm --force "$first_container" >/dev/null
"$verify_adapter" release "$driver" "$plugin_id" "$network_name" "$first_container" "$first_ip" \
  >"${evidence_dir}/dhcp-release.txt"

docker run --detach --name "$second_container" --network "$network_name" \
  --label io.firestarssoft.bored-manager.lab-gate=dhcp \
  "$probe_image" sh -c 'trap "exit 0" TERM INT; while :; do sleep 30; done' \
  >"${evidence_dir}/dhcp-second-container-id.txt"
second_ip="$(docker inspect --format "{{with index .NetworkSettings.Networks \"${network_name}\"}}{{.IPAddress}}{{end}}" "$second_container")"
[[ -n "$second_ip" ]] || die 'plugin did not acquire an address after release'
"$verify_adapter" acquire-after-release "$driver" "$plugin_id" "$network_name" "$second_container" "$second_ip" \
  >"${evidence_dir}/dhcp-acquire-after-release.txt"

docker network inspect "$network_name" >"${evidence_dir}/dhcp-network-inspect-final.json"
printf 'dhcp-plugin-gate: PASS: acquire/renew/release adapter checks completed\n'
