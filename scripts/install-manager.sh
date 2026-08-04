#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly REPOSITORY="FireStarsSoft/Bored-Manager"
readonly GITHUB_RELEASES="https://github.com/${REPOSITORY}/releases"
readonly RELEASE_PUBLIC_KEY_PEM_BASE64='@@BORED_MANAGER_RELEASE_PUBLIC_KEY_PEM_BASE64@@'
readonly RELEASE_PUBLIC_KEY_DER_SHA256='@@BORED_MANAGER_RELEASE_PUBLIC_KEY_DER_SHA256@@'
readonly DEFAULT_WEB_PORT="8443"
readonly DEFAULT_AGENT_PORT="9443"

requested_version=""
dry_run=0
no_start=0
skip_local_docker=0
accept_local_docker_risk=0
allow_downgrade=0
work_dir=""

usage() {
  cat <<'USAGE'
Install a signed Bored Manager release on Ubuntu Desktop 24.04 amd64.

Usage: install-manager.sh [options]

Options:
  --version VERSION               Install an exact SemVer release (without or with v)
  --dry-run                       Verify/preflight without changing the host
  --no-start                      Install without enabling or starting services
  --skip-local-docker             Do not offer local Docker registration
  --accept-local-docker-risk      Acknowledge root-equivalent socket access non-interactively
  --allow-downgrade               Authorize an explicit downgrade through the update workflow
  -h, --help                      Show this help

The installer has no skip-signature or skip-hash option.
USAGE
}

log() {
  printf 'bored-manager installer: %s\n' "$*"
}

warn() {
  printf 'bored-manager installer: warning: %s\n' "$*" >&2
}

die() {
  printf 'bored-manager installer: error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -rf -- "$work_dir"
  fi
}
trap cleanup EXIT INT TERM

while (($# > 0)); do
  case "$1" in
    --version)
      (($# >= 2)) || die "--version requires a value"
      requested_version="${2#v}"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --no-start)
      no_start=1
      shift
      ;;
    --skip-local-docker)
      skip_local_docker=1
      shift
      ;;
    --accept-local-docker-risk)
      accept_local_docker_risk=1
      shift
      ;;
    --allow-downgrade)
      allow_downgrade=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
done

if [[ -n "$requested_version" && ! "$requested_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  die "--version must be SemVer"
fi

((EUID != 0)) || die "run this installer as a regular sudo-capable user, not as root"

for command_name in curl openssl base64 sha256sum python3 dpkg dpkg-deb dpkg-query stat mktemp df systemd-creds; do
  command -v "$command_name" >/dev/null 2>&1 || die "required command is missing: $command_name"
done

[[ -r /etc/os-release ]] || die "/etc/os-release is missing"
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] || \
  die "Ubuntu 24.04 is required (found ${ID:-unknown} ${VERSION_ID:-unknown})"
[[ "$(dpkg --print-architecture)" == "amd64" ]] || die "amd64 is required"
[[ -d /run/systemd/system ]] || die "a running systemd instance is required"

for dependency in adduser ca-certificates systemd; do
  dpkg-query -W -f='${db:Status-Status}' "$dependency" 2>/dev/null | grep -qx 'installed' || \
    die "required Debian package is not installed: $dependency"
done

if [[ "$RELEASE_PUBLIC_KEY_PEM_BASE64" == *'BORED_MANAGER_RELEASE_PUBLIC_KEY_PEM_BASE64'* ||
      "$RELEASE_PUBLIC_KEY_DER_SHA256" == *'BORED_MANAGER_RELEASE_PUBLIC_KEY_DER_SHA256'* ]]; then
  die "release trust root is not provisioned; this development template cannot install packages"
fi
[[ "$RELEASE_PUBLIC_KEY_DER_SHA256" =~ ^[0-9a-f]{64}$ ]] || \
  die "embedded release-key fingerprint is invalid"

work_dir="$(mktemp -d)"
chmod 0700 "$work_dir"
public_key="${work_dir}/release-public-key.pem"
printf '%s' "$RELEASE_PUBLIC_KEY_PEM_BASE64" | base64 --decode >"$public_key" || \
  die "cannot decode embedded release public key"
chmod 0600 "$public_key"
key_fingerprint="$(openssl pkey -pubin -in "$public_key" -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
[[ "$key_fingerprint" == "$RELEASE_PUBLIC_KEY_DER_SHA256" ]] || \
  die "embedded release public key does not match its pinned fingerprint"

if [[ -n "$requested_version" ]]; then
  release_base="${GITHUB_RELEASES}/download/v${requested_version}"
else
  release_base="${GITHUB_RELEASES}/latest/download"
fi

curl_common=(
  --proto '=https'
  --proto-redir '=https'
  --tlsv1.2
  --fail
  --location
  --retry 3
  --retry-all-errors
  --connect-timeout 15
  --max-time 300
  --silent
  --show-error
)

download_metadata() {
  local name="$1"
  local destination="$2"
  curl "${curl_common[@]}" --max-filesize 1048576 \
    --output "$destination" "${release_base}/${name}"
}

manifest="${work_dir}/release-manifest-v1.json"
manifest_signature="${work_dir}/release-manifest-v1.json.sig"
checksums="${work_dir}/SHA256SUMS"
checksums_signature="${work_dir}/SHA256SUMS.sig"

log "downloading signed release metadata"
download_metadata release-manifest-v1.json "$manifest"
download_metadata release-manifest-v1.json.sig "$manifest_signature"
openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin \
  -in "$manifest" -sigfile "$manifest_signature" >/dev/null 2>&1 || \
  die "release manifest signature verification failed"

mapfile -t manifest_records < <(python3 - "$manifest" "$requested_version" <<'PY'
import json
import re
import sys

path, requested = sys.argv[1:]
safe_name = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
safe_hash = re.compile(r"^[0-9a-f]{64}$")
semver = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")

try:
    with open(path, "rb") as stream:
        raw = stream.read()
    document = json.loads(raw)
except (OSError, ValueError) as error:
    raise SystemExit(f"invalid release manifest: {error}")

if document.get("schema_version") != 1:
    raise SystemExit("unsupported release manifest schema")
release = document.get("release", {})
version = release.get("version", "")
if not isinstance(version, str) or not semver.fullmatch(version):
    raise SystemExit("invalid release version")
if release.get("tag") != f"v{version}":
    raise SystemExit("release tag/version mismatch")
if requested and version != requested:
    raise SystemExit("downloaded release does not match --version")
source = document.get("source", {})
if source.get("repository") != "https://github.com/FireStarsSoft/Bored-Manager":
    raise SystemExit("unexpected source repository")
compatibility = document.get("compatibility", {})
if compatibility.get("ubuntu") != "24.04" or compatibility.get("architecture") != "amd64":
    raise SystemExit("release is not compatible with Ubuntu 24.04 amd64")

artifacts = document.get("artifacts")
if not isinstance(artifacts, list):
    raise SystemExit("manifest artifacts must be an array")
by_name = {}
packages = {}
for artifact in artifacts:
    if not isinstance(artifact, dict):
        raise SystemExit("invalid artifact record")
    name = artifact.get("name", "")
    digest = artifact.get("sha256", "")
    size = artifact.get("size", 0)
    if not isinstance(name, str) or not safe_name.fullmatch(name) or name in by_name:
        raise SystemExit("unsafe or duplicate artifact name")
    if not isinstance(digest, str) or not safe_hash.fullmatch(digest):
        raise SystemExit(f"invalid digest for {name}")
    if not isinstance(size, int) or isinstance(size, bool) or size < 1 or size > 16 * 1024**3:
        raise SystemExit(f"invalid size for {name}")
    by_name[name] = artifact
    package = artifact.get("package")
    if artifact.get("kind") == "debian-package" and isinstance(package, dict):
        packages[package.get("name")] = artifact

def record(artifact):
    package = artifact.get("package", {})
    return "\t".join([
        artifact["name"], artifact["sha256"], str(artifact["size"]),
        str(package.get("version", "")), str(package.get("architecture", "")),
    ])

checksum = by_name.get("SHA256SUMS")
manager = packages.get("bored-manager")
agent = packages.get("bored-manager-agent")
agent_installer = by_name.get("install-agent.sh")
if not checksum or checksum.get("kind") != "checksums":
    raise SystemExit("SHA256SUMS record is missing")
if not manager or not agent:
    raise SystemExit("manager and agent packages are required")
if not agent_installer or agent_installer.get("kind") != "installer" or agent_installer.get("component") != "agent":
    raise SystemExit("agent installer artifact is required")
for expected, artifact in (("bored-manager", manager), ("bored-manager-agent", agent)):
    package = artifact.get("package", {})
    if package.get("name") != expected or package.get("architecture") != "amd64":
        raise SystemExit(f"invalid package metadata for {expected}")

print(version)
print(record(checksum))
print(record(manager))
print(record(agent))
print(record(agent_installer))
PY
)

((${#manifest_records[@]} == 5)) || die "release manifest is incomplete"
release_version="${manifest_records[0]}"
IFS=$'\t' read -r sums_name sums_sha sums_size _ _ <<<"${manifest_records[1]}"
IFS=$'\t' read -r manager_name manager_sha manager_size manager_deb_version manager_arch <<<"${manifest_records[2]}"
IFS=$'\t' read -r agent_name agent_sha agent_size agent_deb_version agent_arch <<<"${manifest_records[3]}"
IFS=$'\t' read -r agent_installer_name agent_installer_sha agent_installer_size _ _ <<<"${manifest_records[4]}"
[[ "$manager_arch" == "amd64" && "$agent_arch" == "amd64" ]] || \
  die "manifest package architecture is not amd64"

required_kib=$(((manager_size + agent_size + agent_installer_size) * 2 / 1024 + 524288))
for disk_path in "$work_dir" /var; do
  available_kib="$(df -Pk "$disk_path" | awk 'NR == 2 { print $4 }')"
  [[ "$available_kib" =~ ^[0-9]+$ ]] || die "cannot determine free disk space for ${disk_path}"
  ((available_kib >= required_kib)) || \
    die "insufficient free space on ${disk_path}; need at least ${required_kib} KiB available"
done

download_metadata "$sums_name" "$checksums"
download_metadata SHA256SUMS.sig "$checksums_signature"
openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin \
  -in "$checksums" -sigfile "$checksums_signature" >/dev/null 2>&1 || \
  die "SHA256SUMS signature verification failed"
[[ "$(stat -c '%s' "$checksums")" == "$sums_size" ]] || die "SHA256SUMS size mismatch"
[[ "$(sha256sum "$checksums" | awk '{print $1}')" == "$sums_sha" ]] || \
  die "SHA256SUMS digest mismatch"

download_and_verify_package() {
  local name="$1"
  local expected_sha="$2"
  local expected_size="$3"
  local expected_package="$4"
  local expected_version="$5"
  local destination="${work_dir}/${name}"

  log "downloading ${name}"
  curl "${curl_common[@]}" --max-filesize "$expected_size" \
    --output "$destination" "${release_base}/${name}"
  [[ "$(stat -c '%s' "$destination")" == "$expected_size" ]] || \
    die "size mismatch for ${name}"
  [[ "$(sha256sum "$destination" | awk '{print $1}')" == "$expected_sha" ]] || \
    die "digest mismatch for ${name}"
  grep -Fqx "${expected_sha}  ${name}" "$checksums" || \
    die "signed checksums do not contain the exact ${name} record"
  [[ "$(dpkg-deb --field "$destination" Package)" == "$expected_package" ]] || \
    die "unexpected Package field in ${name}"
  [[ "$(dpkg-deb --field "$destination" Version)" == "$expected_version" ]] || \
    die "unexpected Version field in ${name}"
  [[ "$(dpkg-deb --field "$destination" Architecture)" == "amd64" ]] || \
    die "unexpected Architecture field in ${name}"
  dpkg-deb --info "$destination" >/dev/null || die "invalid Debian archive: ${name}"
}

download_and_verify_package "$manager_name" "$manager_sha" "$manager_size" \
  bored-manager "$manager_deb_version"
download_and_verify_package "$agent_name" "$agent_sha" "$agent_size" \
  bored-manager-agent "$agent_deb_version"

agent_installer="${work_dir}/${agent_installer_name}"
log "downloading ${agent_installer_name}"
curl "${curl_common[@]}" --max-filesize "$agent_installer_size" \
  --output "$agent_installer" "${release_base}/${agent_installer_name}"
[[ "$(stat -c '%s' "$agent_installer")" == "$agent_installer_size" ]] || \
  die "size mismatch for ${agent_installer_name}"
[[ "$(sha256sum "$agent_installer" | awk '{print $1}')" == "$agent_installer_sha" ]] || \
  die "digest mismatch for ${agent_installer_name}"
grep -Fqx "${agent_installer_sha}  ${agent_installer_name}" "$checksums" || \
  die "signed checksums do not contain the exact agent installer record"
bash -n "$agent_installer" || die "agent installer has invalid Bash syntax"

log "verified release ${release_version} with release key ${key_fingerprint}"

installed_version=""
if installed_version="$(dpkg-query -W -f='${Version}' bored-manager 2>/dev/null)"; then
  if [[ "$installed_version" != "$manager_deb_version" ]]; then
    if dpkg --compare-versions "$manager_deb_version" lt "$installed_version"; then
      ((allow_downgrade == 1)) || \
        die "refusing downgrade from ${installed_version} to ${manager_deb_version}; use --allow-downgrade with the released update workflow"
    fi
    die "package transitions require the backup-aware update workflow; installer will not overwrite ${installed_version}"
  fi
  log "version ${installed_version} is already installed; package installation is idempotent"
fi

if [[ -z "$installed_version" ]]; then
  for port in "$DEFAULT_WEB_PORT" "$DEFAULT_AGENT_PORT"; do
    if command -v ss >/dev/null 2>&1 && ss -H -ltn | awk '{print $4}' | grep -Eq "(^|:)$port$"; then
      die "TCP port ${port} is already listening"
    fi
  done
fi

if ((dry_run == 1)); then
  log "dry run complete; no system changes were made"
  if [[ -S /var/run/docker.sock ]]; then
    log "local Docker socket exists; registration would still require explicit confirmation"
  else
    log "local Docker socket is absent; manager installation would continue without it"
  fi
  exit 0
fi

command -v sudo >/dev/null 2>&1 || die "sudo is required"
sudo -v

for lock_path in /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock; do
  if command -v fuser >/dev/null 2>&1 && sudo fuser -s "$lock_path"; then
    die "dpkg is busy (${lock_path}); wait for the owning package process"
  fi
done
sudo dpkg --audit || die "dpkg reports an incomplete package transaction"

if [[ -z "$installed_version" ]]; then
  log "installing bored-manager ${manager_deb_version}"
  sudo dpkg --install "${work_dir}/${manager_name}"
fi

provision_agent_ca() {
  local ca_directory="/var/lib/bored-manager/pki"
  local certificate_path="${ca_directory}/agent-ca.crt"
  local plaintext_path="${ca_directory}/agent-ca.key"
  local credential_directory="/etc/credstore.encrypted"
  local credential_path="${credential_directory}/agent-ca.key"
  local temporary_key="${work_dir}/agent-ca.key"
  local temporary_certificate="${work_dir}/agent-ca.crt"

  if sudo test -e "$plaintext_path"; then
    die "plaintext manager CA key exists at ${plaintext_path}; migrate it through the reviewed recovery workflow before installing"
  fi
  if sudo test -f "$certificate_path" && sudo test -f "$credential_path"; then
    log "reusing the existing encrypted manager CA credential"
    return 0
  fi
  if sudo test -e "$certificate_path" || sudo test -e "$credential_path"; then
    die "manager CA certificate/credential pair is incomplete; restore the matching pair before continuing"
  fi

  log "creating the manager CA as an encrypted systemd credential"
  umask 077
  openssl genpkey -algorithm ED25519 -out "$temporary_key"
  openssl req -new -x509 -key "$temporary_key" -out "$temporary_certificate" \
    -days 3650 -subj '/O=FireStarsSoft/CN=Bored Manager Agent CA' \
    -addext 'basicConstraints=critical,CA:TRUE' \
    -addext 'keyUsage=critical,digitalSignature,keyCertSign,cRLSign'
  sudo install -d -o bored-manager -g bored-manager -m 0700 "$ca_directory"
  sudo install -o bored-manager -g bored-manager -m 0644 \
    "$temporary_certificate" "$certificate_path"
  sudo install -d -o root -g root -m 0700 "$credential_directory"
  sudo systemd-creds encrypt --name=agent-ca.key \
    "$temporary_key" "$credential_path" >/dev/null
  sudo chown root:root "$credential_path"
  sudo chmod 0600 "$credential_path"
}

provision_agent_ca

cache_dir="/var/cache/bored-manager/releases/${release_version}"
sudo install -d -o bored-manager -g bored-manager -m 0750 "$cache_dir"
sudo install -o bored-manager -g bored-manager -m 0640 \
  "${work_dir}/${agent_name}" "${cache_dir}/${agent_name}"
sudo install -o bored-manager -g bored-manager -m 0640 \
  "$agent_installer" "${cache_dir}/${agent_installer_name}"
sudo install -o bored-manager -g bored-manager -m 0640 \
  "$manifest" "${cache_dir}/release-manifest-v1.json"
sudo install -o bored-manager -g bored-manager -m 0640 \
  "$manifest_signature" "${cache_dir}/release-manifest-v1.json.sig"
sudo install -o bored-manager -g bored-manager -m 0640 \
  "$checksums" "${cache_dir}/SHA256SUMS"
sudo install -o bored-manager -g bored-manager -m 0640 \
  "$checksums_signature" "${cache_dir}/SHA256SUMS.sig"

if ((no_start == 1)); then
  log "package installed; services were not enabled or started (--no-start)"
  exit 0
fi

sudo systemctl daemon-reload
sudo systemctl enable --now bored-update-helper.service bored-managerd.service

healthy=0
for _ in {1..30}; do
  if sudo systemctl is-active --quiet bored-managerd.service && sudo /usr/bin/bmctl health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
((healthy == 1)) || die "manager did not pass health within 30 seconds; inspect its journal"

configure_local_docker() {
  local socket="/var/run/docker.sock"
  local socket_group
  local confirmation
  local drop_in

  ((skip_local_docker == 0)) || return 0
  [[ -S "$socket" ]] || {
    log "local Docker socket is absent; no local host was registered"
    return 0
  }
  sudo curl --silent --show-error --fail --max-time 5 --unix-socket "$socket" \
    http://localhost/_ping | grep -qx 'OK' || {
      warn "local Docker socket is not a responsive rootful Engine; registration skipped"
      return 0
    }
  socket_group="$(stat -c '%G' "$socket")"
  [[ "$socket_group" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || {
    warn "Docker socket group could not be resolved safely; registration skipped"
    return 0
  }
  [[ "$socket_group" != "root" ]] || {
    warn "Docker socket is owned by group root; registration skipped"
    return 0
  }
  getent group "$socket_group" >/dev/null 2>&1 || {
    warn "Docker socket group does not exist in the system group database; registration skipped"
    return 0
  }

  if ((accept_local_docker_risk == 0)); then
    if [[ ! -t 0 ]]; then
      warn "non-interactive input cannot accept Docker root-equivalent access; registration skipped"
      return 0
    fi
    printf '\nLocal Docker socket access is equivalent to root on this host.\n' >&2
    printf 'Type I UNDERSTAND DOCKER ACCESS IS ROOT-EQUIVALENT to continue: ' >&2
    IFS= read -r confirmation
    [[ "$confirmation" == "I UNDERSTAND DOCKER ACCESS IS ROOT-EQUIVALENT" ]] || {
      log "local Docker registration declined"
      return 0
    }
  fi

  drop_in="${work_dir}/docker-group.conf"
  printf '[Service]\nSupplementaryGroups=%s\n' "$socket_group" >"$drop_in"
  sudo install -d -o root -g root -m 0755 /etc/systemd/system/bored-managerd.service.d
  sudo install -o root -g root -m 0644 "$drop_in" \
    /etc/systemd/system/bored-managerd.service.d/docker-group.conf
  sudo systemctl daemon-reload
  sudo systemctl restart bored-managerd.service

  for _ in {1..30}; do
    if sudo /usr/bin/bmctl health >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  sudo /usr/bin/bmctl health >/dev/null 2>&1 || \
    die "manager became unhealthy after granting Docker socket group"

  if sudo /usr/bin/bmctl docker-host add-local --help >/dev/null 2>&1; then
    sudo /usr/bin/bmctl docker-host add-local --name local --socket "$socket" \
      --confirmation "I UNDERSTAND DOCKER ACCESS IS ROOT-EQUIVALENT" || {
      warn "manager remained healthy but rejected local host seeding; no host record was created"
      return 0
    }
    log "registered the local Docker Engine"
  else
    warn "installed bmctl cannot seed the local host; permission is configured but no host record was created"
  fi
}

configure_local_docker

log "installation complete"
log "setup URL: https://127.0.0.1:${DEFAULT_WEB_PORT}/setup"
sudo /usr/bin/bmctl diagnostics || warn "run 'sudo bmctl diagnostics' to print TLS fingerprint details"
