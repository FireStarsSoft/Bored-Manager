#!/usr/bin/env bash
set -euo pipefail

readonly OGEN_VERSION="v1.23.0"
readonly BUF_VERSION="v1.72.0"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

go run "github.com/ogen-go/ogen/cmd/ogen@${OGEN_VERSION}" \
  -config api/openapi/v1/ogen.yml \
  -target api/gen/openapi \
  -package openapiv1 \
  -clean \
  api/openapi/v1/openapi.yaml

(
  cd api/proto
  go run "github.com/bufbuild/buf/cmd/buf@${BUF_VERSION}" lint
  go run "github.com/bufbuild/buf/cmd/buf@${BUF_VERSION}" generate
)

npm --prefix web run generate:api
