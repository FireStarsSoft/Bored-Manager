from __future__ import annotations

import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "verify-release-readiness.py"
SPEC = importlib.util.spec_from_file_location("verify_release_readiness", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
verify_release_readiness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify_release_readiness)


class VerifyReleaseReadinessTest(unittest.TestCase):
    tag = "v1.0.0"
    commit = "a" * 40

    def report(self) -> dict[str, object]:
        return {
            "schema_version": 1,
            "release_tag": self.tag,
            "release_commit": self.commit,
            "certified_platforms": sorted(verify_release_readiness.REQUIRED_PLATFORMS),
            "docker": {
                "reference": "29.6.2",
                "compatibility_floor": "28.5.1",
                "rootful": True,
            },
            "completed_at": "2026-08-04T00:00:00Z",
            "approvers": ["reviewer-one", "reviewer-two"],
            "gates": {
                name: {"passed": True, "evidence_sha256": "b" * 64}
                for name in verify_release_readiness.REQUIRED_GATES
            },
        }

    def run_check(self, report: dict[str, object]) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / f"{self.tag}.json"
            path.write_text(json.dumps(report), encoding="utf-8")
            return subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--tag",
                    self.tag,
                    "--commit",
                    self.commit,
                    "--directory",
                    directory,
                ],
                check=False,
                capture_output=True,
                text=True,
            )

    def test_accepts_complete_dual_platform_certification(self):
        result = self.run_check(self.report())
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_certification_missing_kali(self):
        report = self.report()
        report["certified_platforms"] = ["Ubuntu Desktop 24.04 LTS amd64"]
        result = self.run_check(report)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("certified platforms", result.stderr)


if __name__ == "__main__":
    unittest.main()
