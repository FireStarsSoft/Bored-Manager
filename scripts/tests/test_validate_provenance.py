from __future__ import annotations

import base64
import importlib.util
import json
import pathlib
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "validate_provenance.py"
SPEC = importlib.util.spec_from_file_location("validate_provenance", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
validate_provenance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validate_provenance)


class ValidateProvenanceTest(unittest.TestCase):
    digest = "a" * 64
    expected = {"install-manager.sh": digest}

    def bundle(self, *, subject_digest: str | None = None, predicate_type: str | None = None):
        statement = {
            "_type": "https://in-toto.io/Statement/v1",
            "predicateType": predicate_type or "https://slsa.dev/provenance/v1",
            "subject": [
                {
                    "name": "install-manager.sh",
                    "digest": {"sha256": subject_digest or self.digest},
                }
            ],
            "predicate": {},
        }
        payload = base64.b64encode(
            json.dumps(statement, separators=(",", ":")).encode()
        ).decode()
        return {
            "mediaType": "application/vnd.dev.sigstore.bundle.v0.3+json",
            "verificationMaterial": {"certificate": {"rawBytes": "Y2VydA=="}},
            "dsseEnvelope": {
                "payloadType": "application/vnd.in-toto+json",
                "payload": payload,
                "signatures": [{"sig": "c2lnbmF0dXJl"}],
            },
        }

    def write(self, value: object) -> pathlib.Path:
        temporary = tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False)
        self.addCleanup(pathlib.Path(temporary.name).unlink, missing_ok=True)
        with temporary:
            json.dump(value, temporary, separators=(",", ":"))
            temporary.write("\n")
        return pathlib.Path(temporary.name)

    def test_accepts_sigstore_bundle_with_exact_subject(self):
        validate_provenance.validate_bundle(self.write(self.bundle()), self.expected)

    def test_rejects_raw_in_toto_statement(self):
        statement = {
            "_type": "https://in-toto.io/Statement/v1",
            "predicateType": "https://slsa.dev/provenance/v1",
            "subject": [],
            "predicate": {},
        }
        with self.assertRaisesRegex(validate_provenance.ProvenanceError, "Sigstore bundle"):
            validate_provenance.validate_bundle(self.write(statement), self.expected)

    def test_rejects_subject_digest_mismatch(self):
        with self.assertRaisesRegex(validate_provenance.ProvenanceError, "mismatched"):
            validate_provenance.validate_bundle(
                self.write(self.bundle(subject_digest="b" * 64)), self.expected
            )

    def test_rejects_wrong_predicate_type(self):
        with self.assertRaisesRegex(validate_provenance.ProvenanceError, "SLSA provenance"):
            validate_provenance.validate_bundle(
                self.write(self.bundle(predicate_type="https://example.invalid/predicate")),
                self.expected,
            )

    def test_rejects_duplicate_json_keys(self):
        path = self.write(self.bundle())
        path.write_text('{"mediaType":"a","mediaType":"b"}\n', encoding="utf-8")
        with self.assertRaisesRegex(validate_provenance.ProvenanceError, "duplicate JSON key"):
            validate_provenance.validate_bundle(path, self.expected)


if __name__ == "__main__":
    unittest.main()
