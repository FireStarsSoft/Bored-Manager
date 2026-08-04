# Bored Manager certification lab

This directory contains destructive, lab-only feasibility checks. It is not an alternate
installer and it must never run against production Docker hosts.

The reference lab host remains Ubuntu Desktop 24.04 amd64 with rootful Docker. Production support
remains blocked until both mandatory gates produce reviewed reference-host evidence and the
systemd/container gate also covers every advertised runtime platform:

| Gate | Current repository status | Required evidence |
| --- | --- | --- |
| systemd/cgroup v2 container | **Not certified** | Digest-pinned Ubuntu 24.04 and Kali Linux Rolling images each start systemd as PID 1, run a transient unit, and stop cleanly with Docker's default AppArmor/seccomp profile. |
| external DHCP plugin | **Not certified** | Exact plugin identity/version plus acquire, renew, release, mismatch-rejection, and cleanup evidence from the target LAN. |

The scripts reject mutable image tags. They do not use privileged mode, `CAP_SYS_ADMIN`, an
unconfined AppArmor/seccomp profile, or host PID/network/cgroup namespaces. A failed gate is an
architecture-review stop, not permission to relax those controls.

Run the policy-only check anywhere:

```bash
bash lab/gates/policy-check.sh
```

Run live gates only on an isolated certified lab host. The Ubuntu reference host remains the
control environment; Kali is an additional runtime/package target, not a replacement release-build
host. The DHCP verification adapter is a plugin-specific, root-owned executable installed outside
this repository; it receives a fixed operation and fixed positional fields and must independently
inspect the authoritative lease system.

```bash
export BM_SYSTEMD_IMAGE='ubuntu@sha256:REPLACE_WITH_64_HEX_DIGEST'
export BM_DHCP_PROBE_IMAGE='ubuntu@sha256:REPLACE_WITH_64_HEX_DIGEST'
export BM_DHCP_DRIVER='REPLACE_WITH_INSTALLED_PLUGIN_ALIAS'
export BM_DHCP_PLUGIN_ID='REPLACE_WITH_EXACT_DOCKER_PLUGIN_ID'
export BM_DHCP_VERIFY_ADAPTER='/usr/local/libexec/bored-manager-dhcp-gate'
bash lab/gates/run.sh
```

Repeat the systemd/container evidence run with a reviewed, digest-pinned Kali Linux Rolling image.
Record `ID=kali`, `VERSION_ID`, `VERSION_CODENAME=kali-rolling`, and whether the image was built from
the official `kali-rolling` or `kali-last-snapshot` suite. Never certify a mixed-repository image.

`run.sh` prints an evidence directory. Preserve its logs, Docker/plugin inspection output, host
inventory, OS/suite metadata, image digests, and the resulting ADR. A reviewer must compare the evidence with
[ADR 0002](../docs/adr/0002-feasibility-gates-block-production.md) before changing a gate from
blocked to passed.
