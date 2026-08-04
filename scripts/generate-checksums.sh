#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

usage() {
  cat <<'USAGE'
Usage: scripts/generate-checksums.sh OUTPUT FILE [FILE ...]

Generate deterministic GNU SHA256SUMS records using safe basenames. OUTPUT must not be one of the
input files.
USAGE
}

die() {
  printf 'generate-checksums: error: %s\n' "$*" >&2
  exit 1
}

(($# >= 2)) || {
  usage >&2
  exit 2
}

output="$1"
shift
export LC_ALL=C
output_absolute="$(readlink -m -- "$output")"
work_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT INT TERM

declare -A seen=()
for input in "$@"; do
  [[ -f "$input" ]] || die "input is not a file: $input"
  [[ "$(readlink -m -- "$input")" != "$output_absolute" ]] || die "output cannot hash itself"
  name="$(basename -- "$input")"
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]] || die "unsafe filename: $name"
  [[ -z "${seen[$name]:-}" ]] || die "duplicate basename: $name"
  seen[$name]=1
  ln -- "$input" "${work_dir}/${name}" 2>/dev/null || cp -- "$input" "${work_dir}/${name}"
done

mkdir -p -- "$(dirname -- "$output")"
(
  cd -- "$work_dir"
  LC_ALL=C sha256sum -- *
) >"${output}.tmp"
mv -- "${output}.tmp" "$output"
