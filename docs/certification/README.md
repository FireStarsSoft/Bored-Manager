# Stable release certification

Stable tags fail closed unless this directory contains a reviewed `<tag>.json` record accepted by
`scripts/verify-release-readiness.py`. Pre-release tags can be built without a stable certification
record only for lab testing and must be described as uncertified. A prerelease may claim
installer-enabled Kali compatibility only after promotion reviewers attach platform-matrix evidence
for its exact tag and tested Kali package snapshot; that evidence does not make the prerelease a
stable release.

The record binds every required acceptance gate to the exact release tag, Git commit, both
certified manager platforms (`Ubuntu Desktop 24.04 LTS amd64` and `Kali Linux Rolling amd64`), two
distinct reviewers, and a SHA-256 digest of immutable external lab evidence. Kali evidence records
the tested point-release metadata, actual `kali-rolling` or `kali-last-snapshot` apt suite, and
package snapshot even though the public compatibility ID is `kali-rolling`. Hosts that mix Ubuntu,
Debian, multiple Kali-suite, or third-party distribution repositories are not certifiable. Evidence
itself may be stored in the restricted certification system; its digest must be committed here. A
green simulation does not satisfy a real-host or duration gate.

No certification record exists yet. Therefore the repository intentionally cannot publish a
stable release. Never add a fabricated or placeholder record to unblock a workflow.
