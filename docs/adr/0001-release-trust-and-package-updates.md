# ADR-0001: Offline release signatures and dpkg-owned updates

- Status: accepted
- Date: 2026-08-04
- Owners: @FireStarsSoft
- Related issues/PRs: initial implementation

## Context

Bored Manager installs root-capable components and manages long-lived SQLite/PKI state. Executing
network-delivered shell or replacing standalone binaries without package/state coordination would
make compromise and rollback failure difficult to contain. GitHub authentication and attestations
are useful but do not replace an operator-controlled release identity.

## Decision

Release manifests and checksums are signed by an offline Ed25519 key. Installers embed the reviewed
public key and verify manifest, checksums, hash, size, architecture, and Debian control metadata
before invoking `sudo`. Dpkg owns binaries, units, Web assets, and the installed public key.

Updates are staged below `/var/cache/bored-manager/staged` and passed to a root helper over a Unix
socket. The helper checks `SO_PEERCRED`, accepts fixed operations/filenames only, independently
verifies the package, and invokes `/usr/bin/dpkg`. Manager transitions require an online backup,
health deadline, and matching package/database rollback. The helper does not accept a URL or shell
command.

The one-line installer's initial bootstrap still trusts its HTTPS delivery. High-assurance users
must independently verify the release-key fingerprint, signed manifest, and installer hash.

## Alternatives considered

- Direct `curl | sudo bash`: rejected because execution precedes independent artifact validation
  and cleanup/error behavior is weak.
- GitHub attestations only: rejected as the sole trust root because repository/workflow control and
  release identity should be separable.
- Atomic standalone binary swap: rejected because it diverges from dpkg state and complicates
  coordinated schema/unit/Web-asset rollback.
- Online private signing key in Actions: rejected because workflow compromise could sign a release.

## Consequences

Release promotion requires an offline signing step and protected environment. Development
installer templates fail closed until the public trust root exists. Package and DB versions remain
coordinated, while recovery requires retaining N-1 package plus its pre-migration backup.

## Validation

CI validates installer syntax, package metadata/layout, manifest schema, and exact action pins.
Promotion re-downloads the complete draft, verifies both signatures, rejects unexpected assets,
checks package-embedded key equality, and publishes without rebuilding.

## Rollback or supersession

A key transition requires a new ADR and an old-key authorization plus an independent announcement.
Published assets are never replaced; defects are superseded by a higher release.
