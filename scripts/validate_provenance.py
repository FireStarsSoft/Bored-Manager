#!/usr/bin/env python3
"""Validate the structure and subjects of a GitHub Sigstore provenance bundle.

Cryptographic verification remains the responsibility of ``gh attestation verify`` during
release promotion. This validator is deliberately strict about the bytes that the offline release
manifest signs, so a raw in-toto statement or a bundle for different artifacts cannot masquerade
as the required provenance asset.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import pathlib
import re
import sys
from typing import Any


BUNDLE_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json"
IN_TOTO_MEDIA_TYPE = "application/vnd.in-toto+json"
IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1"
SLSA_PROVENANCE_TYPE = "https://slsa.dev/provenance/v1"
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
MAX_BUNDLE_BYTES = 16 * 1024 * 1024
MAX_BUNDLES = 64


class ProvenanceError(ValueError):
    """Raised when provenance bytes violate the release contract."""


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ProvenanceError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _decode_json(raw: bytes, description: str) -> Any:
    try:
        return json.loads(raw, object_pairs_hook=_strict_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ProvenanceError) as error:
        raise ProvenanceError(f"invalid {description}: {error}") from error


def _decode_base64(value: Any, description: str) -> bytes:
    if not isinstance(value, str) or not value:
        raise ProvenanceError(f"{description} must be non-empty base64")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ProvenanceError(f"{description} is not valid base64") from error
    if not decoded:
        raise ProvenanceError(f"{description} decodes to empty bytes")
    return decoded


def parse_expected_subject(value: str) -> tuple[str, str]:
    name, separator, digest = value.partition("=")
    if not separator or not SAFE_NAME.fullmatch(name) or not SHA256.fullmatch(digest):
        raise argparse.ArgumentTypeError("expected subject must be NAME=64_LOWERCASE_HEX")
    return name, digest


def validate_bundle(path: pathlib.Path, expected_subjects: dict[str, str]) -> None:
    if not expected_subjects:
        raise ProvenanceError("at least one expected subject is required")
    try:
        size = path.stat().st_size
        if size < 1 or size > MAX_BUNDLE_BYTES:
            raise ProvenanceError("bundle size is outside 1 byte through 16 MiB")
        lines = [line for line in path.read_bytes().splitlines() if line.strip()]
    except OSError as error:
        raise ProvenanceError(f"cannot read bundle: {error}") from error
    if not lines or len(lines) > MAX_BUNDLES:
        raise ProvenanceError(f"bundle must contain 1 through {MAX_BUNDLES} JSON lines")

    actual_subjects: dict[str, str] = {}
    for index, line in enumerate(lines, start=1):
        bundle = _decode_json(line, f"Sigstore bundle JSON on line {index}")
        if not isinstance(bundle, dict) or bundle.get("mediaType") != BUNDLE_MEDIA_TYPE:
            raise ProvenanceError(f"line {index} is not a Sigstore bundle v0.3")
        if not isinstance(bundle.get("verificationMaterial"), dict) or not bundle[
            "verificationMaterial"
        ]:
            raise ProvenanceError(f"line {index} has no verification material")
        envelope = bundle.get("dsseEnvelope")
        if not isinstance(envelope, dict):
            raise ProvenanceError(f"line {index} has no DSSE envelope")
        if envelope.get("payloadType") != IN_TOTO_MEDIA_TYPE:
            raise ProvenanceError(f"line {index} has an unexpected DSSE payload type")
        signatures = envelope.get("signatures")
        if not isinstance(signatures, list) or not signatures:
            raise ProvenanceError(f"line {index} has no DSSE signature")
        for signature_index, signature in enumerate(signatures, start=1):
            if not isinstance(signature, dict):
                raise ProvenanceError(
                    f"line {index} signature {signature_index} is not an object"
                )
            _decode_base64(signature.get("sig"), f"line {index} signature {signature_index}")

        payload = _decode_base64(envelope.get("payload"), f"line {index} DSSE payload")
        statement = _decode_json(payload, f"in-toto statement on line {index}")
        if not isinstance(statement, dict):
            raise ProvenanceError(f"line {index} statement is not an object")
        if statement.get("_type") != IN_TOTO_STATEMENT_TYPE:
            raise ProvenanceError(f"line {index} is not an in-toto Statement v1")
        if statement.get("predicateType") != SLSA_PROVENANCE_TYPE:
            raise ProvenanceError(f"line {index} is not SLSA provenance v1")
        if not isinstance(statement.get("predicate"), dict):
            raise ProvenanceError(f"line {index} has no SLSA predicate object")
        subjects = statement.get("subject")
        if not isinstance(subjects, list) or not subjects:
            raise ProvenanceError(f"line {index} has no subjects")
        for subject in subjects:
            if not isinstance(subject, dict):
                raise ProvenanceError(f"line {index} contains an invalid subject")
            name = subject.get("name")
            digest = subject.get("digest")
            if not isinstance(name, str) or not SAFE_NAME.fullmatch(name):
                raise ProvenanceError(f"line {index} contains an unsafe subject name")
            if not isinstance(digest, dict) or set(digest) != {"sha256"}:
                raise ProvenanceError(f"subject {name} must have exactly one SHA-256 digest")
            sha256 = digest["sha256"]
            if not isinstance(sha256, str) or not SHA256.fullmatch(sha256):
                raise ProvenanceError(f"subject {name} has an invalid SHA-256 digest")
            if name in actual_subjects:
                raise ProvenanceError(f"duplicate provenance subject: {name}")
            actual_subjects[name] = sha256

    if actual_subjects != expected_subjects:
        missing = sorted(expected_subjects.keys() - actual_subjects.keys())
        unexpected = sorted(actual_subjects.keys() - expected_subjects.keys())
        mismatched = sorted(
            name
            for name in expected_subjects.keys() & actual_subjects.keys()
            if expected_subjects[name] != actual_subjects[name]
        )
        raise ProvenanceError(
            "provenance subjects do not match release artifacts; "
            f"missing={missing}, unexpected={unexpected}, mismatched={mismatched}"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle", type=pathlib.Path)
    parser.add_argument(
        "subject", nargs="+", type=parse_expected_subject, metavar="NAME=SHA256"
    )
    args = parser.parse_args()
    expected: dict[str, str] = {}
    for name, digest in args.subject:
        if name in expected:
            parser.error(f"duplicate expected subject: {name}")
        expected[name] = digest
    try:
        validate_bundle(args.bundle, expected)
    except ProvenanceError as error:
        raise SystemExit(f"validate-provenance: error: {error}") from error
    return 0


if __name__ == "__main__":
    sys.exit(main())
