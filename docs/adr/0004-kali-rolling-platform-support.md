# ADR-0004: Support Kali Linux Rolling alongside Ubuntu 24.04

- Status: accepted
- Date: 2026-08-04
- Owners: @FireStarsSoft
- Related ADRs: ADR-0002, ADR-0003

## Context

Bored Manager originally restricted manager hosts, Docker hosts, and managed containers to Ubuntu
24.04 LTS amd64. Operators also need Kali Linux Rolling amd64, but treating every Debian-derived
system as interchangeable would make package, systemd, Docker, and rollback claims impossible to
certify.

Kali's numeric `VERSION_ID` advances with point-in-time image releases. The stable OS-lineage
identity is the exact `/etc/os-release` pair `ID=kali` and
`VERSION_CODENAME=kali-rolling`. Both the continuously moving official `kali-rolling` suite and the
safer frozen official `kali-last-snapshot` suite expose that lineage, so `/etc/os-release` alone
cannot distinguish which suite supplies installed packages.

Kali's rolling package set can change after an application release is signed. Mixing Ubuntu,
Debian, multiple Kali-suite, or third-party distribution repositories creates a platform that was
not tested and can invalidate dependency and rollback evidence.

No signed Bored Manager v1 release manifest has ever been published. The unreleased v1 platform
fields can therefore be corrected before the first signed release without creating an installed
v1 compatibility obligation. Once a signed release is published, its manifest schema and
canonical signature input are immutable.

## Decision

Bored Manager supports these amd64 runtime targets:

- Ubuntu Desktop 24.04 LTS and Kali Linux Rolling for the manager host;
- Ubuntu 24.04 LTS and Kali Linux Rolling for rootful Docker hosts; and
- systemd-enabled Ubuntu 24.04 LTS and Kali Linux Rolling managed containers.

The canonical public platform identifiers are `ubuntu-24.04` and `kali-rolling`. Kali is accepted
only when `ID=kali` and `VERSION_CODENAME=kali-rolling`; `ID_LIKE=debian` is never sufficient. The
numeric Kali `VERSION_ID` is recorded for diagnostics and certification but does not become part of
the public compatibility identifier.

A Kali target may consistently use either the official `kali-rolling` suite or the official
`kali-last-snapshot` suite. Certification and support evidence must record the actual suite,
repository configuration after redaction, numeric `VERSION_ID`, package snapshot, kernel, systemd,
dpkg, and Docker versions. A target that mixes distribution repositories is unsupported and cannot
be certified.

Ubuntu 24.04 remains the reproducible development, release-build, and reference lab host. Kali is
an additional installation and runtime target. The same amd64 Debian packages may serve both only
after package lifecycle and platform gates pass independently on each target.

Prereleases may be built without a stable certification record for lab testing, but must be labeled
uncertified. A prerelease may claim installer-enabled Kali compatibility only when promotion
reviewers attach evidence for its exact tag, Kali suite/package snapshot, install lifecycle, and
mixed Ubuntu/Kali interoperability. Stable promotion requires the reviewed certification record to
cover both supported platforms.

The release manifest and public service-definition contract may replace their unreleased
Ubuntu-specific compatibility fields with OS-neutral platform lists before the first signed v1
release. Generated clients must be regenerated from the source contract rather than edited by
hand.

## Consequences

- Installer, inventory, catalog, release-manifest, diagnostics, and UI wording must use the two
  canonical platform identifiers.
- Rolling Kali support is evidence-bound, not an unconditional promise about future package state.
  A material Kali transition requires a fresh canary and may require a superseding prerelease.
- Certification covers same-platform and mixed manager/agent combinations so Ubuntu support is not
  weakened while Kali is added.
- Kali repository-suite detection cannot be inferred from `/etc/os-release`; diagnostics and lab
  evidence must inspect repository configuration separately and redact private mirror names.
- Ubuntu-only build runners remain valid, but they do not replace real Kali install, systemd,
  update, rollback, remove, and residue tests.

## Validation

Release evidence must demonstrate:

1. exact Ubuntu and Kali OS-lineage normalization with amd64 enforcement;
2. rejection of other distributions, architectures, and repository mixing;
3. manager and agent install, repeat install, upgrade, rollback, remove, and residue checks on both
   supported platforms;
4. Ubuntu manager to Kali agent and Kali manager to Ubuntu agent enrollment, reconnect, update, and
   rollback compatibility;
5. systemd PID 1 container behavior under the default AppArmor/seccomp and cgroup v2 policy for
   both platform images; and
6. immutable evidence containing image/package digests and the actual Kali suite and snapshot.

## Rollback or supersession

If a Kali package transition invalidates a certified release, maintainers stop advertising that
release for the affected Kali snapshot, preserve evidence, and issue a corrected higher version.
They do not weaken OS checks, mix repositories, replace published assets, or silently represent an
uncertified Kali state as supported. Removing or changing Kali support requires a superseding ADR;
Ubuntu 24.04 support remains independently certified.
