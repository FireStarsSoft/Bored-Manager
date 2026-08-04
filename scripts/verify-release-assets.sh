#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

release_dir=""
public_key=""
expected_fingerprint_file=""
expected_tag=""
expected_commit=""

usage() {
  cat <<'USAGE'
Usage: scripts/verify-release-assets.sh --directory DIR --public-key FILE \
  --fingerprint-file FILE --tag vX.Y.Z --commit 40_HEX

Verify offline signatures, exact manifest hashes/sizes, checksums, Debian metadata, installer trust
root, and release tag. Verification fails on missing, duplicate, or unsafe records.
USAGE
}

die() {
  printf 'verify-release-assets: error: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --directory)
      (($# >= 2)) || die "--directory requires a value"
      release_dir="$2"
      shift 2
      ;;
    --public-key)
      (($# >= 2)) || die "--public-key requires a value"
      public_key="$2"
      shift 2
      ;;
    --fingerprint-file)
      (($# >= 2)) || die "--fingerprint-file requires a value"
      expected_fingerprint_file="$2"
      shift 2
      ;;
    --tag)
      (($# >= 2)) || die "--tag requires a value"
      expected_tag="$2"
      shift 2
      ;;
    --commit)
      (($# >= 2)) || die "--commit requires a value"
      expected_commit="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -d "$release_dir" ]] || die "release directory is required"
[[ -f "$public_key" ]] || die "release public key is required"
[[ -f "$expected_fingerprint_file" ]] || die "committed fingerprint file is required"
[[ "$expected_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "invalid tag"
[[ "$expected_commit" =~ ^[0-9a-f]{40}$ ]] || die "invalid release commit"
for command_name in openssl sha256sum python3 dpkg-deb grep stat; do
  command -v "$command_name" >/dev/null 2>&1 || die "required command is missing: $command_name"
done

expected_fingerprint="$(tr -d '[:space:]' <"$expected_fingerprint_file")"
[[ "$expected_fingerprint" =~ ^[0-9a-f]{64}$ ]] || die "invalid committed key fingerprint"
actual_fingerprint="$(openssl pkey -pubin -in "$public_key" -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
[[ "$actual_fingerprint" == "$expected_fingerprint" ]] || die "release key fingerprint mismatch"

manifest="${release_dir}/release-manifest-v1.json"
manifest_signature="${release_dir}/release-manifest-v1.json.sig"
checksums="${release_dir}/SHA256SUMS"
checksums_signature="${release_dir}/SHA256SUMS.sig"
for required_file in "$manifest" "$manifest_signature" "$checksums" "$checksums_signature"; do
  [[ -f "$required_file" ]] || die "missing required release file: $(basename -- "$required_file")"
  [[ ! -L "$required_file" ]] || \
    die "symbolic-link release metadata is forbidden: $(basename -- "$required_file")"
done

openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin \
  -in "$manifest" -sigfile "$manifest_signature" >/dev/null 2>&1 || \
  die "manifest signature verification failed"
openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin \
  -in "$checksums" -sigfile "$checksums_signature" >/dev/null 2>&1 || \
  die "SHA256SUMS signature verification failed"

python3 - "$manifest" "$release_dir" "$expected_tag" "$expected_commit" "$checksums" "$public_key" \
  "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/validate_provenance.py" <<'PY'
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import tempfile

manifest_path = pathlib.Path(sys.argv[1])
release_dir = pathlib.Path(sys.argv[2]).resolve()
expected_tag = sys.argv[3]
expected_commit = sys.argv[4]
checksums_path = pathlib.Path(sys.argv[5])
public_key_path = pathlib.Path(sys.argv[6])
provenance_validator = pathlib.Path(sys.argv[7])
safe_name = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
safe_hash = re.compile(r"^[0-9a-f]{64}$")

with manifest_path.open("rb") as stream:
    manifest = json.load(stream)
if manifest.get("schema_version") != 1:
    raise SystemExit("unsupported manifest schema")
release = manifest.get("release", {})
if release.get("tag") != expected_tag or f"v{release.get('version', '')}" != expected_tag:
    raise SystemExit("manifest tag/version mismatch")
source = manifest.get("source", {})
if source.get("repository") != "https://github.com/FireStarsSoft/Bored-Manager":
    raise SystemExit("source repository mismatch")
if source.get("commit") != expected_commit:
    raise SystemExit("source commit does not match the release checkout")
compat = manifest.get("compatibility", {})
if compat.get("ubuntu") != "24.04" or compat.get("architecture") != "amd64":
    raise SystemExit("unsupported compatibility record")

records = {}
packages = set()
provenance_paths = []
for artifact in manifest.get("artifacts", []):
    if not isinstance(artifact, dict):
        raise SystemExit("invalid artifact")
    name = artifact.get("name", "")
    digest = artifact.get("sha256", "")
    size = artifact.get("size", 0)
    if not safe_name.fullmatch(name) or name in records:
        raise SystemExit("unsafe or duplicate artifact name")
    if not safe_hash.fullmatch(digest) or not isinstance(size, int) or isinstance(size, bool) or size < 1:
        raise SystemExit(f"invalid digest/size for {name}")
    candidate = release_dir / name
    if candidate.is_symlink():
        raise SystemExit(f"symbolic-link artifact is forbidden: {name}")
    path = candidate.resolve()
    if path.parent != release_dir or not path.is_file():
        raise SystemExit(f"missing artifact: {name}")
    data_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    if data_hash != digest or path.stat().st_size != size:
        raise SystemExit(f"artifact hash/size mismatch: {name}")
    records[name] = digest
    if artifact.get("kind") == "sbom":
        try:
            sbom = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise SystemExit(f"invalid SPDX SBOM {name}: {error}")
        if not str(sbom.get("spdxVersion", "")).startswith("SPDX-") or not isinstance(
            sbom.get("packages"), list
        ):
            raise SystemExit(f"invalid SPDX document structure: {name}")
    if artifact.get("kind") == "provenance":
        provenance_paths.append(path)
    package = artifact.get("package")
    if artifact.get("kind") == "debian-package":
        if not isinstance(package, dict):
            raise SystemExit(f"missing package metadata: {name}")
        actual_name = subprocess.check_output(
            ["dpkg-deb", "--field", str(path), "Package"], text=True
        ).strip()
        actual_version = subprocess.check_output(
            ["dpkg-deb", "--field", str(path), "Version"], text=True
        ).strip()
        actual_arch = subprocess.check_output(
            ["dpkg-deb", "--field", str(path), "Architecture"], text=True
        ).strip()
        if (actual_name, actual_version, actual_arch) != (
            package.get("name"), package.get("version"), package.get("architecture")
        ):
            raise SystemExit(f"Debian metadata mismatch: {name}")
        packages.add(actual_name)
        if actual_name == "bored-manager":
            with tempfile.TemporaryDirectory() as temporary_directory:
                subprocess.run(
                    ["dpkg-deb", "--extract", str(path), temporary_directory], check=True
                )
                packaged_key = (
                    pathlib.Path(temporary_directory)
                    / "usr/share/bored-manager/release-signing.pub"
                )
                if not packaged_key.is_file() or packaged_key.read_bytes() != public_key_path.read_bytes():
                    raise SystemExit("manager package release trust root mismatch")

required_roles = {
    "install-manager.sh": ("installer", "manager"),
    "install-agent.sh": ("installer", "agent"),
    "SHA256SUMS": ("checksums", "release"),
    "bored-manager.spdx.json": ("sbom", "release"),
    "bored-manager.intoto.jsonl": ("provenance", "release"),
}
manifest_roles = {
    artifact.get("name"): (artifact.get("kind"), artifact.get("component"))
    for artifact in manifest.get("artifacts", [])
    if isinstance(artifact, dict)
}
if any(manifest_roles.get(name) != role for name, role in required_roles.items()):
    raise SystemExit("required release artifact role/name mapping is missing")
if packages != {"bored-manager", "bored-manager-agent"}:
    raise SystemExit("release must contain manager and agent packages")
if len(provenance_paths) != 1 or provenance_paths[0].name != "bored-manager.intoto.jsonl":
    raise SystemExit("release must contain exactly one canonical provenance bundle")

provenance_subject_names = {"install-manager.sh", "install-agent.sh"}
provenance_subject_names.update(
    artifact["name"]
    for artifact in manifest["artifacts"]
    if artifact.get("kind") == "debian-package"
)
provenance_command = [sys.executable, str(provenance_validator), str(provenance_paths[0])]
provenance_command.extend(
    f"{name}={records[name]}" for name in sorted(provenance_subject_names)
)
provenance_result = subprocess.run(
    provenance_command, check=False, capture_output=True, text=True
)
if provenance_result.returncode != 0:
    detail = provenance_result.stderr.strip() or provenance_result.stdout.strip()
    raise SystemExit(detail or "provenance validation failed")

expected_release_files = set(records) | {
    "release-manifest-v1.json",
    "release-manifest-v1.json.sig",
    "SHA256SUMS.sig",
}
actual_release_files = {path.name for path in release_dir.iterdir() if path.is_file()}
if actual_release_files != expected_release_files:
    unexpected = sorted(actual_release_files - expected_release_files)
    missing = sorted(expected_release_files - actual_release_files)
    raise SystemExit(f"release asset set mismatch; unexpected={unexpected}, missing={missing}")

checksum_records = {}
for line in checksums_path.read_text(encoding="utf-8").splitlines():
    match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._+-]*)", line)
    if not match or match.group(2) in checksum_records:
        raise SystemExit("unsafe or duplicate SHA256SUMS record")
    checksum_records[match.group(2)] = match.group(1)
expected_checksum_records = {name: digest for name, digest in records.items() if name != "SHA256SUMS"}
if checksum_records != expected_checksum_records:
    raise SystemExit("SHA256SUMS and manifest artifact sets differ")
PY

for installer in "${release_dir}/install-manager.sh" "${release_dir}/install-agent.sh"; do
  bash -n "$installer"
  ! grep -q '@@BORED_MANAGER_' "$installer" || die "unresolved installer marker: $(basename -- "$installer")"
  grep -Fq "$expected_fingerprint" "$installer" || \
    die "installer does not pin the committed release key: $(basename -- "$installer")"
done

printf 'verify-release-assets: verified %s with key %s\n' "$expected_tag" "$actual_fingerprint"
