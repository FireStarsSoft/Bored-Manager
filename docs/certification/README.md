# Stable release certification

Stable tags fail closed unless this directory contains a reviewed `<tag>.json` record accepted by
`scripts/verify-release-readiness.py`. Pre-release tags can be built for lab testing without such a
record, but cannot be represented as stable releases.

The record binds every required acceptance gate to the exact release tag, Git commit, certified
Ubuntu/Docker platform, two distinct reviewers, and a SHA-256 digest of immutable external lab
evidence. Evidence itself may be stored in the restricted certification system; its digest must be
committed here. A green simulation does not satisfy a real-host or duration gate.

No certification record exists yet. Therefore the repository intentionally cannot publish a
stable release. Never add a fabricated or placeholder record to unblock a workflow.
