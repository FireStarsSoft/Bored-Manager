#!/usr/bin/env python3
"""Generate the canonical Bored Manager release-manifest-v1.json.

The script computes artifact size/hash itself and extracts Debian metadata with dpkg-deb. Output
uses stable key ordering and compact separators; signing is always a separate offline operation.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import pathlib
import re
import subprocess
import sys
from typing import Any


SEMVER = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
KINDS = {"installer", "debian-package", "checksums", "sbom", "provenance"}
COMPONENTS = {"manager", "agent", "release"}


def parse_artifact(value: str) -> tuple[str, str, pathlib.Path]:
    try:
        kind, component, raw_path = value.split(":", 2)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "artifact must be KIND:COMPONENT:PATH"
        ) from exc
    if kind not in KINDS:
        raise argparse.ArgumentTypeError(f"unsupported artifact kind: {kind}")
    if component not in COMPONENTS:
        raise argparse.ArgumentTypeError(f"unsupported component: {component}")
    path = pathlib.Path(raw_path)
    if not path.is_file():
        raise argparse.ArgumentTypeError(f"artifact is not a file: {path}")
    if not SAFE_NAME.fullmatch(path.name):
        raise argparse.ArgumentTypeError(f"unsafe artifact filename: {path.name}")
    return kind, component, path


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def deb_field(path: pathlib.Path, field: str) -> str:
    try:
        result = subprocess.run(
            ["dpkg-deb", "--field", str(path), field],
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        raise RuntimeError(f"cannot read {field} from {path}") from exc
    value = result.stdout.strip()
    if not value or "\n" in value:
        raise RuntimeError(f"invalid {field} in {path}")
    return value


def published_at(value: str | None) -> str:
    if value is None:
        now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        return now.isoformat().replace("+00:00", "Z")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--published-at must be RFC 3339") from exc
    if parsed.tzinfo is None:
        raise argparse.ArgumentTypeError("--published-at must include a timezone")
    return parsed.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--channel", choices=("prerelease", "stable"), required=True)
    parser.add_argument("--published-at")
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument(
        "--agent-compat",
        action="append",
        required=True,
        help="compatible agent series, for example 0.1.x",
    )
    parser.add_argument(
        "--artifact",
        type=parse_artifact,
        action="append",
        required=True,
        metavar="KIND:COMPONENT:PATH",
    )
    args = parser.parse_args()

    if not SEMVER.fullmatch(args.version):
        parser.error("--version must be SemVer without a leading v")
    if not COMMIT.fullmatch(args.commit):
        parser.error("--commit must be a lowercase 40-character Git commit")

    seen_names: set[str] = set()
    artifacts: list[dict[str, Any]] = []
    package_names: set[str] = set()
    for kind, component, path in args.artifact:
        if path.name in seen_names:
            parser.error(f"duplicate artifact filename: {path.name}")
        seen_names.add(path.name)
        item: dict[str, Any] = {
            "name": path.name,
            "kind": kind,
            "component": component,
            "sha256": sha256(path),
            "size": path.stat().st_size,
        }
        if kind == "debian-package":
            package_name = deb_field(path, "Package")
            if package_name not in {"bored-manager", "bored-manager-agent"}:
                parser.error(f"unexpected Debian package: {package_name}")
            architecture = deb_field(path, "Architecture")
            if architecture != "amd64":
                parser.error(f"unsupported Debian architecture: {architecture}")
            expected_component = (
                "manager" if package_name == "bored-manager" else "agent"
            )
            if component != expected_component:
                parser.error(
                    f"package {package_name} must use component {expected_component}"
                )
            package_names.add(package_name)
            item["package"] = {
                "name": package_name,
                "version": deb_field(path, "Version"),
                "architecture": architecture,
            }
        artifacts.append(item)

    if package_names != {"bored-manager", "bored-manager-agent"}:
        parser.error("manifest requires exactly the manager and agent Debian packages")
    required_roles = {
        "install-manager.sh": ("installer", "manager"),
        "install-agent.sh": ("installer", "agent"),
        "SHA256SUMS": ("checksums", "release"),
        "bored-manager.spdx.json": ("sbom", "release"),
        "bored-manager.intoto.jsonl": ("provenance", "release"),
    }
    actual_roles = {
        item["name"]: (item["kind"], item["component"]) for item in artifacts
    }
    for name, role in required_roles.items():
        if actual_roles.get(name) != role:
            parser.error(f"manifest is missing required {role[0]} artifact {name}")

    manifest = {
        "schema_version": 1,
        "release": {
            "version": args.version,
            "tag": f"v{args.version}",
            "channel": args.channel,
            "published_at": published_at(args.published_at),
        },
        "source": {
            "repository": "https://github.com/FireStarsSoft/Bored-Manager",
            "commit": args.commit,
        },
        "compatibility": {
            "operating_systems": ["kali-rolling", "ubuntu-24.04"],
            "architecture": "amd64",
            "manager_supports_agent": sorted(set(args.agent_compat)),
        },
        "artifacts": sorted(artifacts, key=lambda item: item["name"]),
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(manifest, output, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        output.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(f"generate-release-manifest: error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
