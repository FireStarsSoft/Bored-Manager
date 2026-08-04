# Release and promotion runbook

> Status: release-process specification. No production release key is stored in this repository.

## Roles and trust

- The build workflow produces deterministic amd64 `.deb` files, installers, SPDX SBOMs,
  provenance, checksums, and an unsigned manifest in a draft release. The provenance asset is a
  JSON-serialized Sigstore bundle whose DSSE payload is an in-toto Statement v1 with SLSA
  provenance v1 and exact SHA-256 subjects for both packages and both installers.
- An offline signer reviews the build evidence and signs the canonical manifest and `SHA256SUMS`
  with the protected Ed25519 key.
- A separate promotion workflow uses only the committed public key, verifies all assets and policy
  gates, and publishes the existing draft. It cannot sign or alter artifacts.

The private key must never be placed in GitHub Actions secrets, a developer repository, a command
line, an environment variable, or a support bundle.

## Prepare

1. Confirm a clean commit on protected `main`, required checks, code review, and non-empty release
   notes. Tags use `vX.Y.Z` for stable releases or `vX.Y.Z-suffix` for prereleases.
2. Confirm SemVer, manager N ↔ agent N/N-1 compatibility, migration/rollback coverage, and README
   commands on clean Ubuntu 24.04 LTS and Kali Linux Rolling amd64 targets. Kali evidence must record
   `ID=kali`, `VERSION_CODENAME=kali-rolling`, the numeric `VERSION_ID`, the selected official
   `kali-rolling` or `kali-last-snapshot` suite, and the tested package snapshot.
3. Confirm systemd-container and DHCP feasibility gates for any feature that depends on them on
   every affected target platform.
4. Verify dependency licenses, vulnerability results, CodeQL, secret scanning, SBOM tooling, and
   pinned action SHAs.
5. Tag only after policy checks. Stable `v1.0.0` additionally requires every acceptance gate in
   `PLAN.md`.

## Build draft

The workflow runs tests, builds with version/commit/time metadata, calls `scripts/build-deb.sh`,
generates SBOM/provenance, creates `SHA256SUMS`, and calls
`scripts/generate-release-manifest.py`. Before signing, the draft asset set contains exactly the
versioned manager and agent `.deb` packages, `install-manager.sh`, `install-agent.sh`,
`release-manifest-v1.json`, `SHA256SUMS`, `bored-manager.spdx.json`, and
`bored-manager.intoto.jsonl`. It uploads a draft release; GitHub's generated source archives are not
installer assets, and no unsigned draft may be advertised as installable.

Download the entire draft into a new offline-signing workspace and cryptographically verify the
Sigstore bundle against every package and installer with `gh attestation verify --bundle`, then
verify checksums, expected filenames, Debian control fields, unit files, installer placeholders,
and the manifest schema. Test install, repeat install, upgrade, rollback, remove, and residue on
clean Ubuntu 24.04 LTS and Kali Linux Rolling amd64 targets before signing.

## Sign offline

Sign the exact byte representation of `release-manifest-v1.json` and `SHA256SUMS`. Do not
pretty-print, reorder, or edit after signing. Produce raw Ed25519 signature files named:

- `release-manifest-v1.json.sig`
- `SHA256SUMS.sig`

Record the signing-key fingerprint and transfer only public artifacts back to the release draft.
Add `release-manifest-v1.json.sig` and `SHA256SUMS.sig`, then re-download the complete draft and
verify once more from a clean environment.

## Promote

Run the manual promotion workflow with the exact tag. It must fail closed unless:

- the release exists and is still draft;
- tag and manifest version agree;
- both signatures match the committed public key;
- every required asset occurs exactly once and hash/size/type agree;
- the release notes explicitly state whether the release is installer-enabled, list the certified
  platforms, and do not describe an uncertified prerelease as stable;
- `.deb` package name, architecture, and version agree;
- installers contain the expected production key/fingerprint and no template marker;
- the locally downloaded Sigstore bundle verifies each package and installer, was signed by the
  repository's release-build workflow on a GitHub-hosted runner, and names no different subject;
- tests, docs, compatibility, and rollout evidence are attached.

Publish the draft without rebuilding or replacing assets. Enable immutable releases when supported.
After publication, download `install-manager.sh` with `curl --fail` into a temporary file and run it
in `--dry-run` mode before the install/upgrade/rollback smoke test. For a stable release, verify both
the exact-tag URL and `/releases/latest/download/install-manager.sh`. GitHub does not select
prereleases for `/latest/`; prereleases must be tested only through their exact tag-specific URL and
exact `--version`. A 404 is a failed promotion check, not permission to execute the raw template
from `main`.

## Revoke or supersede

Do not replace files on a published release. If an artifact is defective, mark the release
affected, publish an advisory, stop its update channel, and issue a higher version. A signing-key
incident follows `SECURITY.md` and requires an explicit trust-root transition.
