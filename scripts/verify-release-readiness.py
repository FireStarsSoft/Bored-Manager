#!/usr/bin/env python3
"""Fail closed unless a stable tag has a complete, reviewable certification record."""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys


STABLE_TAG = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
REQUIRED_GATES = {
    "systemd_cgroup_v2",
    "dhcp_plugin",
    "local_docker_socket",
    "remote_docker_ssh",
    "mtls_enrollment_revocation",
    "pty_cleanup",
    "sqlite_load_retention",
    "simulated_streams_1000",
    "installer_matrix",
    "monitoring_alerts",
    "dashboard_1000x20",
    "terminal_batch_cancellation",
    "provisioning_networking",
    "signed_update_canary_rollback",
    "backup_restore_migration",
    "remove_purge_ownership",
    "documentation_scenarios",
    "security_acceptance",
    "real_containers_10_24h",
    "real_containers_100_48h",
    "scale_agents_1000_72h",
    "batch_start_skew_p95",
    "resource_limits",
}


def fail(message: str) -> None:
    raise SystemExit(f"release-readiness: error: {message}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--directory", default="docs/certification")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not COMMIT.fullmatch(args.commit):
        fail("--commit must be a lowercase 40-character Git object ID")
    if not STABLE_TAG.fullmatch(args.tag):
        print(f"release-readiness: {args.tag} is a prerelease; stable certification is not applicable")
        return 0

    report_path = pathlib.Path(args.directory) / f"{args.tag}.json"
    if not report_path.is_file():
        fail(f"stable release certification is missing: {report_path}")
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        fail(f"cannot read certification report: {error}")

    if report.get("schema_version") != 1:
        fail("unsupported certification schema")
    if report.get("release_tag") != args.tag or report.get("release_commit") != args.commit:
        fail("certification tag/commit does not match the release checkout")
    if report.get("certified_platform") != "Ubuntu Desktop 24.04 LTS amd64":
        fail("certified platform must be Ubuntu Desktop 24.04 LTS amd64")
    docker = report.get("docker", {})
    if docker != {"reference": "29.6.2", "compatibility_floor": "28.5.1", "rootful": True}:
        fail("Docker certification record is incomplete or unsupported")
    completed_at = report.get("completed_at")
    if not isinstance(completed_at, str) or not re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", completed_at
    ):
        fail("completed_at must be an RFC 3339 UTC second timestamp")
    approvers = report.get("approvers")
    if not isinstance(approvers, list) or len(set(approvers)) < 2 or not all(
        isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9-]{1,39}", value)
        for value in approvers
    ):
        fail("at least two distinct GitHub approvers are required")

    gates = report.get("gates")
    if not isinstance(gates, dict):
        fail("gates must be an object")
    missing = sorted(REQUIRED_GATES - gates.keys())
    if missing:
        fail(f"required gates are missing: {', '.join(missing)}")
    for name in sorted(REQUIRED_GATES):
        gate = gates[name]
        if not isinstance(gate, dict) or gate.get("passed") is not True:
            fail(f"gate did not pass: {name}")
        if not SHA256.fullmatch(str(gate.get("evidence_sha256", ""))):
            fail(f"gate evidence hash is invalid: {name}")

    print(f"release-readiness: stable certification passed for {args.tag} at {args.commit}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
