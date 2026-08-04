#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

die() {
  printf 'verify-deb: error: %s\n' "$*" >&2
  exit 1
}

(($# == 2)) || die "usage: verify-deb.sh MANAGER.deb AGENT.deb"
manager_deb="$1"
agent_deb="$2"

for command_name in dpkg-deb stat find grep mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || die "required command is missing: ${command_name}"
done
[[ -f "$manager_deb" ]] || die "manager package does not exist: ${manager_deb}"
[[ -f "$agent_deb" ]] || die "agent package does not exist: ${agent_deb}"

[[ "$(dpkg-deb --field "$manager_deb" Package)" == "bored-manager" ]] || \
  die "manager Package field is invalid"
[[ "$(dpkg-deb --field "$agent_deb" Package)" == "bored-manager-agent" ]] || \
  die "agent Package field is invalid"
[[ "$(dpkg-deb --field "$manager_deb" Architecture)" == "amd64" ]] || \
  die "manager package is not amd64"
[[ "$(dpkg-deb --field "$agent_deb" Architecture)" == "amd64" ]] || \
  die "agent package is not amd64"
[[ "$(dpkg-deb --field "$manager_deb" Version)" == \
   "$(dpkg-deb --field "$agent_deb" Version)" ]] || die "package versions do not match"

work_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT INT TERM

manager_root="${work_dir}/manager"
agent_root="${work_dir}/agent"
mkdir -p -- "$manager_root" "$agent_root"
dpkg-deb --extract "$manager_deb" "$manager_root"
dpkg-deb --extract "$agent_deb" "$agent_root"

assert_mode() {
  local expected="$1"
  local path="$2"
  [[ -e "$path" ]] || die "required package path is missing: ${path#"$work_dir"/}"
  [[ "$(stat -c '%a' "$path")" == "$expected" ]] || \
    die "unexpected mode on ${path#"$work_dir"/}: $(stat -c '%a' "$path")"
}

assert_mode 755 "${manager_root}/usr/bin/bored-managerd"
assert_mode 755 "${manager_root}/usr/bin/bmctl"
assert_mode 755 "${manager_root}/usr/lib/bored-manager/bored-update-helper"
assert_mode 644 "${manager_root}/usr/share/bored-manager/web/index.html"
assert_mode 644 "${manager_root}/usr/lib/systemd/system/bored-managerd.service"
assert_mode 644 "${manager_root}/usr/share/doc/bored-manager/README.MD"
assert_mode 755 "${agent_root}/usr/bin/bored-agentd"
assert_mode 644 "${agent_root}/usr/lib/systemd/system/bored-agentd.service"
assert_mode 644 "${agent_root}/usr/share/doc/bored-manager-agent/README.MD"

grep -Fqx 'LoadCredentialEncrypted=agent-ca.key' \
  "${manager_root}/usr/lib/systemd/system/bored-managerd.service" || \
  die "manager unit does not load the encrypted CA credential"
grep -Fqx 'PrivateTmp=yes' \
  "${manager_root}/usr/lib/systemd/system/bored-update-helper.service" || \
  die "update helper does not isolate its root-owned temporary workspace"
grep -Fqx 'User=root' "${agent_root}/usr/lib/systemd/system/bored-agentd.service" || \
  die "agent unit does not explicitly run as root"

if find "$manager_root" "$agent_root" -xdev -type f -perm -0002 -print -quit | grep -q .; then
  die "package contains a world-writable regular file"
fi
if find "$manager_root" "$agent_root" -xdev -type f \( -perm -4000 -o -perm -2000 \) \
  -print -quit | grep -q .; then
  die "package contains a setuid or setgid regular file"
fi
if find "$manager_root" -xdev -type f -name 'agent-ca.key' -print -quit | grep -q .; then
  die "manager package contains a CA private key"
fi

if command -v systemd-analyze >/dev/null 2>&1; then
  system_root="${work_dir}/system-root"
  mkdir -p -- "$system_root"
  dpkg-deb --extract "$manager_deb" "$system_root"
  dpkg-deb --extract "$agent_deb" "$system_root"
  if ! systemd_output="$(systemd-analyze --root="$system_root" --recursive-errors=no --man=no verify \
    bored-managerd.service bored-update-helper.service bored-agentd.service 2>&1)"; then
    printf '%s\n' "$systemd_output" >&2
    die "systemd unit verification failed"
  fi
fi

printf 'verify-deb: validated %s and %s\n' "$manager_deb" "$agent_deb"
