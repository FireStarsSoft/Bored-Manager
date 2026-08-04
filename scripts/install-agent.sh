#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly RELEASE_PUBLIC_KEY_PEM_BASE64='@@BORED_MANAGER_RELEASE_PUBLIC_KEY_PEM_BASE64@@'
readonly RELEASE_PUBLIC_KEY_DER_SHA256='@@BORED_MANAGER_RELEASE_PUBLIC_KEY_DER_SHA256@@'

manager_url=""
manager_spki_pin=""
requested_version=""
dry_run=0
no_start=0
work_dir=""

usage() {
  cat <<'USAGE'
Install an exact signed Bored Manager agent package and request UI approval.

Usage: install-agent.sh --manager-url URL --manager-spki-pin PIN --version VERSION [options]

Required:
  --manager-url URL          HTTPS URL of the manager artifact endpoint
  --manager-spki-pin PIN     curl-style sha256//BASE64 public-key pin
  --version VERSION          Exact compatible SemVer release

Options:
  --ca-pin PIN               Deprecated alias for --manager-spki-pin
  --dry-run                  Verify/preflight without changing the container
  --no-start                 Install and configure without enabling/starting the agent
  -h, --help                 Show this help

Enrollment uses a locally generated key/CSR and explicit manager UI approval. This script accepts
no bearer enrollment token and has no skip-signature or skip-hash option.
USAGE
}

log() {
  printf 'bored-manager agent installer: %s\n' "$*"
}

die() {
  printf 'bored-manager agent installer: error: %s\n' "$*" >&2
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
    --manager-url)
      (($# >= 2)) || die "--manager-url requires a value"
      manager_url="${2%/}"
      shift 2
      ;;
    --manager-spki-pin|--ca-pin)
      (($# >= 2)) || die "$1 requires a value"
      manager_spki_pin="$2"
      shift 2
      ;;
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
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "$manager_url" ]] || die "--manager-url is required"
[[ -n "$manager_spki_pin" ]] || die "--manager-spki-pin is required"
[[ "$requested_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || \
  die "--version must be an exact SemVer"
[[ "$manager_spki_pin" =~ ^sha256//[A-Za-z0-9+/]{43}=?$ ]] || \
  die "--manager-spki-pin must use curl's sha256//BASE64 format"

((EUID != 0)) || die "run this installer as a regular sudo-capable user, not as root"

for command_name in curl openssl base64 sha256sum python3 dpkg dpkg-deb dpkg-query stat mktemp df; do
  command -v "$command_name" >/dev/null 2>&1 || die "required command is missing: $command_name"
done

python3 - "$manager_url" <<'PY' || exit 1
import sys
from urllib.parse import urlsplit

url = urlsplit(sys.argv[1])
if url.scheme != "https" or not url.hostname or url.username or url.password:
    raise SystemExit("manager URL must be HTTPS without embedded credentials")
if url.path not in ("", "/") or url.query or url.fragment:
    raise SystemExit("manager URL must contain only an HTTPS origin")
if any(ord(character) < 0x21 or ord(character) > 0x7e or character in "'\"\\" for character in sys.argv[1]):
    raise SystemExit("manager URL contains characters unsafe for the root-owned environment file")
try:
    port = url.port
except ValueError as error:
    raise SystemExit(f"manager URL has an invalid port: {error}") from error
if port is not None and not 1 <= port <= 65535:
    raise SystemExit("manager URL port is outside 1-65535")
PY

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

release_base="${manager_url}/api/v1/artifacts/releases/v${requested_version}"
curl_common=(
  --proto '=https'
  --tlsv1.2
  # The bootstrap endpoint may be self-signed. Exact SPKI verification below
  # replaces public-CA chain validation for this connection.
  --insecure
  --pinnedpubkey "$manager_spki_pin"
  --fail
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

log "downloading signed release metadata from the pinned manager"
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
try:
    with open(path, "rb") as stream:
        document = json.load(stream)
except (OSError, ValueError) as error:
    raise SystemExit(f"invalid release manifest: {error}")
if document.get("schema_version") != 1:
    raise SystemExit("unsupported release manifest schema")
release = document.get("release", {})
if release.get("version") != requested or release.get("tag") != f"v{requested}":
    raise SystemExit("release version/tag mismatch")
if document.get("source", {}).get("repository") != "https://github.com/FireStarsSoft/Bored-Manager":
    raise SystemExit("unexpected source repository")
compatibility = document.get("compatibility", {})
if compatibility.get("ubuntu") != "24.04" or compatibility.get("architecture") != "amd64":
    raise SystemExit("release is not compatible with Ubuntu 24.04 amd64")

by_name = {}
agent = None
for artifact in document.get("artifacts", []):
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
    package = artifact.get("package", {})
    if artifact.get("kind") == "debian-package" and package.get("name") == "bored-manager-agent":
        agent = artifact

checksum = by_name.get("SHA256SUMS")
if not checksum or checksum.get("kind") != "checksums" or agent is None:
    raise SystemExit("required checksum/agent artifact is missing")
package = agent.get("package", {})
if package.get("architecture") != "amd64" or not package.get("version"):
    raise SystemExit("invalid agent package metadata")

def record(artifact):
    package = artifact.get("package", {})
    return "\t".join([
        artifact["name"], artifact["sha256"], str(artifact["size"]),
        str(package.get("version", "")),
    ])

print(record(checksum))
print(record(agent))
PY
)

((${#manifest_records[@]} == 2)) || die "release manifest is incomplete"
IFS=$'\t' read -r sums_name sums_sha sums_size _ <<<"${manifest_records[0]}"
IFS=$'\t' read -r agent_name agent_sha agent_size agent_deb_version <<<"${manifest_records[1]}"

required_kib=$((agent_size * 2 / 1024 + 262144))
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

agent_deb="${work_dir}/${agent_name}"
log "downloading ${agent_name}"
curl "${curl_common[@]}" --max-filesize "$agent_size" \
  --output "$agent_deb" "${release_base}/${agent_name}"
[[ "$(stat -c '%s' "$agent_deb")" == "$agent_size" ]] || die "agent package size mismatch"
[[ "$(sha256sum "$agent_deb" | awk '{print $1}')" == "$agent_sha" ]] || \
  die "agent package digest mismatch"
grep -Fqx "${agent_sha}  ${agent_name}" "$checksums" || \
  die "signed checksums do not contain the exact agent package record"
[[ "$(dpkg-deb --field "$agent_deb" Package)" == "bored-manager-agent" ]] || \
  die "unexpected agent Package field"
[[ "$(dpkg-deb --field "$agent_deb" Version)" == "$agent_deb_version" ]] || \
  die "unexpected agent Version field"
[[ "$(dpkg-deb --field "$agent_deb" Architecture)" == "amd64" ]] || \
  die "unexpected agent Architecture field"
dpkg-deb --info "$agent_deb" >/dev/null || die "invalid agent Debian archive"

installed_version=""
if installed_version="$(dpkg-query -W -f='${Version}' bored-manager-agent 2>/dev/null)"; then
  [[ "$installed_version" == "$agent_deb_version" ]] || \
    die "agent package transitions require the manager's signed rollout workflow (installed ${installed_version})"
  log "version ${installed_version} is already installed; package installation is idempotent"
fi

log "verified agent release ${requested_version} with release key ${key_fingerprint}"
if ((dry_run == 1)); then
  log "dry run complete; no system changes were made and no enrollment request was sent"
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
  sudo dpkg --install "$agent_deb"
fi

agent_environment="${work_dir}/agent.env"
printf 'BORED_AGENT_MANAGER_URL=%s\nBORED_AGENT_MANAGER_SPKI_PIN=%s\n' \
  "$manager_url" "$manager_spki_pin" >"$agent_environment"
sudo install -d -o root -g root -m 0750 /etc/bored-manager
sudo install -o root -g root -m 0600 "$agent_environment" /etc/bored-manager/agent.env

if ((no_start == 1)); then
  log "agent installed/configured; service was not enabled or started (--no-start)"
  exit 0
fi

sudo systemctl daemon-reload
sudo systemctl enable --now bored-agentd.service

active=0
for _ in {1..30}; do
  if sudo systemctl is-active --quiet bored-agentd.service; then
    active=1
    break
  fi
  sleep 1
done
((active == 1)) || die "agent service did not become active; inspect its journal"

log "agent is running and should appear as pending approval within 60 seconds"
log "compare the CSR fingerprint and verification code on the target and in the manager UI"
sudo journalctl -u bored-agentd.service -n 20 --no-pager || true
