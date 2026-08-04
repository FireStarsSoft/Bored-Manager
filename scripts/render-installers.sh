#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly REPOSITORY_ROOT

public_key=""
output_dir=""

usage() {
  cat <<'USAGE'
Usage: scripts/render-installers.sh --public-key FILE --output-dir DIRECTORY

Render release installer templates with an Ed25519 public key and pinned DER SHA-256. The private
key is neither accepted nor needed.
USAGE
}

die() {
  printf 'render-installers: error: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --public-key)
      (($# >= 2)) || die "--public-key requires a value"
      public_key="$2"
      shift 2
      ;;
    --output-dir)
      (($# >= 2)) || die "--output-dir requires a value"
      output_dir="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -f "$public_key" ]] || die "Ed25519 public key file is required"
[[ -n "$output_dir" ]] || die "--output-dir is required"
for command_name in openssl base64 sha256sum python3; do
  command -v "$command_name" >/dev/null 2>&1 || die "required command is missing: $command_name"
done

openssl pkey -pubin -in "$public_key" -noout -text 2>/dev/null | grep -q 'ED25519' || \
  die "public key must be an Ed25519 public key in PEM format"
key_base64="$(base64 --wrap=0 "$public_key")"
key_fingerprint="$(openssl pkey -pubin -in "$public_key" -outform DER | sha256sum | awk '{print $1}')"

mkdir -p -- "$output_dir"
for installer_name in install-manager.sh install-agent.sh; do
  source_path="${REPOSITORY_ROOT}/scripts/${installer_name}"
  destination_path="${output_dir}/${installer_name}"
  [[ -f "$source_path" ]] || die "missing installer template: ${source_path}"
  python3 - "$source_path" "$destination_path" "$key_base64" "$key_fingerprint" <<'PY'
import os
import pathlib
import sys

source, destination, key_base64, fingerprint = sys.argv[1:]
text = pathlib.Path(source).read_text(encoding="utf-8")
key_marker = "@@BORED_MANAGER_RELEASE_PUBLIC_KEY_PEM_BASE64@@"
fingerprint_marker = "@@BORED_MANAGER_RELEASE_PUBLIC_KEY_DER_SHA256@@"
if text.count(key_marker) != 1 or text.count(fingerprint_marker) != 1:
    raise SystemExit(f"unexpected trust-root marker count in {source}")
text = text.replace(key_marker, key_base64).replace(fingerprint_marker, fingerprint)
if "@@BORED_MANAGER_" in text:
    raise SystemExit(f"unresolved release marker in {source}")
target = pathlib.Path(destination)
target.write_text(text, encoding="utf-8", newline="\n")
os.chmod(target, 0o755)
PY
  bash -n "$destination_path"
done

printf 'render-installers: release-key DER SHA-256 %s\n' "$key_fingerprint"
