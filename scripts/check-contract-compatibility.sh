#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly BUF_VERSION="v1.72.0"
readonly OASDIFF_VERSION="v1.27.0"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

base_ref="${1:-}"
if [[ -z "$base_ref" || "$base_ref" =~ ^0+$ ]] || \
   ! git cat-file -e "${base_ref}^{commit}" 2>/dev/null; then
  printf 'contract-compatibility: no reachable baseline; initial contract accepted\n'
  exit 0
fi

work_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT INT TERM

if git cat-file -e "${base_ref}:api/proto/buf.yaml" 2>/dev/null; then
  mkdir -p "${work_dir}/baseline"
  git archive "$base_ref" api/proto | tar -x -C "${work_dir}/baseline"
  (
    cd api/proto
    go run "github.com/bufbuild/buf/cmd/buf@${BUF_VERSION}" breaking \
      --against "${work_dir}/baseline/api/proto"
  )
else
  printf 'contract-compatibility: baseline has no Protobuf contract; accepting initial schema\n'
fi

if git cat-file -e "${base_ref}:api/openapi/v1/openapi.yaml" 2>/dev/null; then
  mkdir -p "${work_dir}/baseline"
  git archive "$base_ref" api/openapi/v1 | tar -x -C "${work_dir}/baseline"
  go run "github.com/oasdiff/oasdiff@${OASDIFF_VERSION}" breaking \
    --fail-on WARN \
    --allow-external-refs \
    "${work_dir}/baseline/api/openapi/v1/openapi.yaml" \
    api/openapi/v1/openapi.yaml
else
  printf 'contract-compatibility: baseline has no OpenAPI contract; accepting initial schema\n'
fi
