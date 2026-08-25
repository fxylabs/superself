#!/usr/bin/env python3
"""Regression tests for the content review receipt verifier."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import sys
import tempfile
import unittest
from pathlib import Path


sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("verify_review_record.py")
SPEC = importlib.util.spec_from_file_location("verify_review_record", SCRIPT)
assert SPEC and SPEC.loader
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


class ReceiptTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "docs/content-plans").mkdir(parents=True)
        (self.root / "docs/content-reviews").mkdir(parents=True)
        (self.root / "src").mkdir()
        (self.root / "docs/content-plans/home.en.md").write_text(
            "# Brief\n\n- Status: approved\n- Revision: v0.1\n", encoding="utf-8"
        )
        (self.root / "src/home.md").write_text("# Home\n", encoding="utf-8")
        self.write_receipt()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_receipt(self, *, author: str = "agent:writer", reviewer: str = "agent:reviewer") -> None:
        digest = VERIFIER.content_digest(self.root, ["src/home.md"])
        text = f"""# Home quality review

- Brief: docs/content-plans/home.en.md
- Brief revision: v0.1
- Content file: src/home.md
- Content SHA-256: {digest}
- Author: {author}
- Reviewer: {reviewer}
- Reviewed at: 2026-08-24
- Verdict: ready

## Review scope
Scope.
## Claims and evidence
Evidence.
## Sentence and visual jobs
Jobs.
## Supported-path run
Run.
## Independent reviewer answers
Answers.
## Reader evidence
Not required by this fixture.
## Remaining hypotheses and next check
Next.
## Sufficient evidence and stop condition
Enough.
"""
        (self.root / "docs/content-reviews/home.en.md").write_text(text, encoding="utf-8")

    def test_ready_receipt_passes(self) -> None:
        with contextlib.redirect_stdout(io.StringIO()):
            VERIFIER.verify(self.root, "docs/content-reviews/home.en.md")

    def test_content_change_makes_receipt_stale(self) -> None:
        (self.root / "src/home.md").write_text("# Changed\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "content digest changed"):
            VERIFIER.verify(self.root, "docs/content-reviews/home.en.md")

    def test_author_cannot_review_own_content(self) -> None:
        self.write_receipt(author="agent:same", reviewer="agent:same")
        with self.assertRaisesRegex(ValueError, "author and reviewer must be different"):
            VERIFIER.verify(self.root, "docs/content-reviews/home.en.md")

    def test_unapproved_brief_blocks_ready(self) -> None:
        (self.root / "docs/content-plans/home.en.md").write_text(
            "# Brief\n\n- Status: review\n- Revision: v0.1\n", encoding="utf-8"
        )
        with self.assertRaisesRegex(ValueError, "brief is not approved"):
            VERIFIER.verify(self.root, "docs/content-reviews/home.en.md")


if __name__ == "__main__":
    unittest.main()
