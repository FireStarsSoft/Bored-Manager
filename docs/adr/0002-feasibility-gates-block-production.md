# ADR 0002: Feasibility gates block production implementation

- Status: Accepted
- Date: 2026-08-04
- Decision owners: FireStarsSoft maintainers

## Context

Bored Manager depends on two platform capabilities that must not be approximated with broad host
privileges: systemd as PID 1 in an Ubuntu 24.04 container under cgroup v2, and an external Docker
network plugin whose DHCP acquire/renew/release behavior is reliable on the target LAN. Neither
capability can be certified from the Windows 11 development workspace or its non-Ubuntu WSL
distribution.

## Decision

The repository may implement foundation and isolated pre-alpha slices, but a production release
remains blocked until `lab/gates/run.sh` passes on the certified Ubuntu Desktop lab and its evidence
is independently reviewed. The systemd gate retains Docker's default AppArmor/seccomp policy and
does not add host namespaces or broad capabilities. The DHCP gate requires an exact installed
plugin ID, digest-pinned probe image, and a plugin-specific authoritative lease verifier.

No failure permits privileged mode, `CAP_SYS_ADMIN`, unconfined AppArmor/seccomp, or host PID,
network, cgroup, or user namespaces as a fallback. A failure reopens the container/network
architecture before feature work continues.

## Current evidence

No certified evidence exists as of 2026-08-04. Both gates are **blocked/not certified**. This ADR
records the stop condition; it is not a successful gate report.

## Consequences

- `v1.0.0` cannot be promoted while either gate is blocked.
- DHCP mode stays disabled and the certified-plugin matrix stays empty.
- UI elements for terminal, provisioning, networking, and lifecycle features must identify
  unavailable pre-alpha capabilities rather than imply production readiness.
- Passing evidence requires a follow-up ADR that records host inventory, immutable image/plugin
  identities, commands, results, reviewers, and retained evidence hashes.
