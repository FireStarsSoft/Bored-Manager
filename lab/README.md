# Bored Manager certification lab

This directory contains destructive, lab-only feasibility checks. It is not an alternate
installer and it must never run against production Docker hosts.

Production implementation remains blocked until both mandatory gates produce reviewed evidence
on Ubuntu Desktop 24.04 amd64 with rootful Docker:

| Gate | Current repository status | Required evidence |
| --- | --- | --- |
| systemd/cgroup v2 container | **Not certified** | Digest-pinned Ubuntu 24.04 image starts systemd as PID 1, runs a transient unit, and stops cleanly with Docker's default AppArmor/seccomp profile. |
| external DHCP plugin | **Not certified** | Exact plugin identity/version plus acquire, renew, release, mismatch-rejection, and cleanup evidence from the target LAN. |

The scripts reject mutable image tags. They do not use privileged mode, `CAP_SYS_ADMIN`, an
unconfined AppArmor/seccomp profile, or host PID/network/cgroup namespaces. A failed gate is an
architecture-review stop, not permission to relax those controls.

Run the policy-only check anywhere:

```bash
bash lab/gates/policy-check.sh
```

Run both live gates only on an isolated certified lab host. The DHCP verification adapter is a
plugin-specific, root-owned executable installed outside this repository; it receives a fixed
operation and fixed positional fields and must independently inspect the authoritative lease
system.

```bash
export BM_SYSTEMD_IMAGE='ubuntu@sha256:REPLACE_WITH_64_HEX_DIGEST'
export BM_DHCP_PROBE_IMAGE='ubuntu@sha256:REPLACE_WITH_64_HEX_DIGEST'
export BM_DHCP_DRIVER='REPLACE_WITH_INSTALLED_PLUGIN_ALIAS'
export BM_DHCP_PLUGIN_ID='REPLACE_WITH_EXACT_DOCKER_PLUGIN_ID'
export BM_DHCP_VERIFY_ADAPTER='/usr/local/libexec/bored-manager-dhcp-gate'
bash lab/gates/run.sh
```

`run.sh` prints an evidence directory. Preserve its logs, Docker/plugin inspection output, host
inventory, image digests, and the resulting ADR. A reviewer must compare the evidence with
[ADR 0002](../docs/adr/0002-feasibility-gates-block-production.md) before changing a gate from
blocked to passed.
