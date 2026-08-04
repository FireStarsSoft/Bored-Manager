#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
readonly VERSION="0.1.0-test.1"
readonly TAG="v${VERSION}"
readonly COMMIT="0000000000000000000000000000000000000000"

for command_name in openssl python3 sha256sum dpkg-deb; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'test-release-pipeline: missing command: %s\n' "$command_name" >&2
    exit 1
  }
done

work_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT INT TERM

private_key="${work_dir}/test-release-private.pem"
public_key="${work_dir}/test-release-public.pem"
fingerprint_file="${work_dir}/test-release-public.sha256"
release_dir="${work_dir}/release"
mkdir -p -- "$release_dir"

# This key exists only for this test and is destroyed with work_dir.
openssl genpkey -algorithm ED25519 -out "$private_key" 2>/dev/null
openssl pkey -in "$private_key" -pubout -out "$public_key" 2>/dev/null
openssl pkey -pubin -in "$public_key" -outform DER 2>/dev/null | \
  sha256sum | awk '{print $1}' >"$fingerprint_file"

bash "${SCRIPT_DIR}/build-deb.sh" \
  --version "$VERSION" \
  --architecture amd64 \
  --output-dir "$release_dir" \
  --release-public-key "$public_key" >/dev/null
bash "${SCRIPT_DIR}/render-installers.sh" \
  --public-key "$public_key" \
  --output-dir "$release_dir" >/dev/null

printf '%s\n' '{"spdxVersion":"SPDX-2.3","packages":[]}' \
  >"${release_dir}/bored-manager.spdx.json"
python3 - "$release_dir" <<'PY'
import base64
import hashlib
import json
import pathlib
import sys

release_dir = pathlib.Path(sys.argv[1])
subject_names = [
    "install-manager.sh",
    "install-agent.sh",
    "bored-manager_0.1.0-test.1-1_amd64.deb",
    "bored-manager-agent_0.1.0-test.1-1_amd64.deb",
]
statement = {
    "_type": "https://in-toto.io/Statement/v1",
    "predicateType": "https://slsa.dev/provenance/v1",
    "subject": [
        {
            "name": name,
            "digest": {"sha256": hashlib.sha256((release_dir / name).read_bytes()).hexdigest()},
        }
        for name in subject_names
    ],
    "predicate": {},
}
payload = base64.b64encode(
    json.dumps(statement, separators=(",", ":")).encode("utf-8")
).decode("ascii")
bundle = {
    "mediaType": "application/vnd.dev.sigstore.bundle.v0.3+json",
    "verificationMaterial": {"certificate": {"rawBytes": "Y2VydA=="}},
    "dsseEnvelope": {
        "payloadType": "application/vnd.in-toto+json",
        "payload": payload,
        "signatures": [{"sig": "c2lnbmF0dXJl"}],
    },
}
(release_dir / "bored-manager.intoto.jsonl").write_text(
    json.dumps(bundle, separators=(",", ":")) + "\n", encoding="utf-8"
)
PY

mapfile -t checksum_inputs < <(
  find "$release_dir" -maxdepth 1 -type f -printf '%p\n' | LC_ALL=C sort
)
bash "${SCRIPT_DIR}/generate-checksums.sh" \
  "${release_dir}/SHA256SUMS" "${checksum_inputs[@]}"

manager_deb="${release_dir}/bored-manager_${VERSION}-1_amd64.deb"
agent_deb="${release_dir}/bored-manager-agent_${VERSION}-1_amd64.deb"
if python3 "${SCRIPT_DIR}/generate-release-manifest.py" \
  --version "$VERSION" \
  --commit "$COMMIT" \
  --channel prerelease \
  --published-at '2026-08-04T00:00:00Z' \
  --agent-compat '0.1.x' \
  --output "${work_dir}/manifest-without-provenance.json" \
  --artifact "installer:manager:${release_dir}/install-manager.sh" \
  --artifact "installer:agent:${release_dir}/install-agent.sh" \
  --artifact "checksums:release:${release_dir}/SHA256SUMS" \
  --artifact "sbom:release:${release_dir}/bored-manager.spdx.json" \
  --artifact "debian-package:manager:${manager_deb}" \
  --artifact "debian-package:agent:${agent_deb}" >/dev/null 2>&1; then
  printf 'test-release-pipeline: manifest without provenance was accepted\n' >&2
  exit 1
fi

python3 "${SCRIPT_DIR}/generate-release-manifest.py" \
  --version "$VERSION" \
  --commit "$COMMIT" \
  --channel prerelease \
  --published-at '2026-08-04T00:00:00Z' \
  --agent-compat '0.1.x' \
  --output "${release_dir}/release-manifest-v1.json" \
  --artifact "installer:manager:${release_dir}/install-manager.sh" \
  --artifact "installer:agent:${release_dir}/install-agent.sh" \
  --artifact "checksums:release:${release_dir}/SHA256SUMS" \
  --artifact "sbom:release:${release_dir}/bored-manager.spdx.json" \
  --artifact "provenance:release:${release_dir}/bored-manager.intoto.jsonl" \
  --artifact "debian-package:manager:${manager_deb}" \
  --artifact "debian-package:agent:${agent_deb}"

openssl pkeyutl -sign -inkey "$private_key" -rawin \
  -in "${release_dir}/release-manifest-v1.json" \
  -out "${release_dir}/release-manifest-v1.json.sig"
openssl pkeyutl -sign -inkey "$private_key" -rawin \
  -in "${release_dir}/SHA256SUMS" \
  -out "${release_dir}/SHA256SUMS.sig"

bash "${SCRIPT_DIR}/verify-release-assets.sh" \
  --directory "$release_dir" \
  --public-key "$public_key" \
  --fingerprint-file "$fingerprint_file" \
  --tag "$TAG" \
  --commit "$COMMIT" >/dev/null

manifest_backup="${work_dir}/release-manifest-v1.json.clean"
cp -- "${release_dir}/release-manifest-v1.json" "$manifest_backup"
python3 - "${release_dir}/release-manifest-v1.json" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
manifest = json.loads(path.read_text(encoding="utf-8"))
manifest["compatibility"]["operating_systems"] = ["ubuntu-24.04"]
path.write_text(
    json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
    newline="\n",
)
PY
openssl pkeyutl -sign -inkey "$private_key" -rawin \
  -in "${release_dir}/release-manifest-v1.json" \
  -out "${release_dir}/release-manifest-v1.json.sig"
if bash "${SCRIPT_DIR}/verify-release-assets.sh" \
  --directory "$release_dir" \
  --public-key "$public_key" \
  --fingerprint-file "$fingerprint_file" \
  --tag "$TAG" \
  --commit "$COMMIT" >/dev/null 2>&1; then
  printf 'test-release-pipeline: incomplete platform compatibility was accepted\n' >&2
  exit 1
fi
cp -- "$manifest_backup" "${release_dir}/release-manifest-v1.json"
openssl pkeyutl -sign -inkey "$private_key" -rawin \
  -in "${release_dir}/release-manifest-v1.json" \
  -out "${release_dir}/release-manifest-v1.json.sig"

if bash "${SCRIPT_DIR}/verify-release-assets.sh" \
  --directory "$release_dir" \
  --public-key "$public_key" \
  --fingerprint-file "$fingerprint_file" \
  --tag "$TAG" \
  --commit '1111111111111111111111111111111111111111' >/dev/null 2>&1; then
  printf 'test-release-pipeline: manifest source commit mismatch was accepted\n' >&2
  exit 1
fi

installer_backup="${work_dir}/install-manager.sh.clean"
cp -- "${release_dir}/install-manager.sh" "$installer_backup"
printf '\n# tampered\n' >>"${release_dir}/install-manager.sh"
if bash "${SCRIPT_DIR}/verify-release-assets.sh" \
  --directory "$release_dir" \
  --public-key "$public_key" \
  --fingerprint-file "$fingerprint_file" \
  --tag "$TAG" \
  --commit "$COMMIT" >/dev/null 2>&1; then
  printf 'test-release-pipeline: tampered installer was accepted\n' >&2
  exit 1
fi

cp -- "$installer_backup" "${release_dir}/install-manager.sh"
printf '\n# tampered agent bootstrap\n' >>"${release_dir}/install-agent.sh"
if bash "${SCRIPT_DIR}/verify-release-assets.sh" \
  --directory "$release_dir" \
  --public-key "$public_key" \
  --fingerprint-file "$fingerprint_file" \
  --tag "$TAG" \
  --commit "$COMMIT" >/dev/null 2>&1; then
  printf 'test-release-pipeline: tampered agent installer was accepted\n' >&2
  exit 1
fi

printf 'test-release-pipeline: provenance/commit bound, signed release accepted, and installer tampering rejected\n'
