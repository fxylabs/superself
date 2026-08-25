#!/usr/bin/env python3
"""Verify the integrity of a content quality review receipt."""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path


FIELD = re.compile(r"^- ([A-Za-z][A-Za-z0-9 -]+):\s*(.*?)\s*$", re.MULTILINE)
REQUIRED_SECTIONS = (
    ("Review scope", "검토 범위"),
    ("Claims and evidence", "주장과 근거"),
    ("Sentence and visual jobs", "문장·시각 자료 역할"),
    ("Supported-path run", "실제 실행", "지원 절차 실행"),
    ("Independent reviewer answers", "독립 리뷰 답변"),
    ("Reader evidence", "독자 확인"),
    ("Remaining hypotheses and next check", "남은 가설과 다음 확인"),
    ("Sufficient evidence and stop condition", "충분한 근거와 중지 조건"),
)


def safe_path(root: Path, raw: str) -> Path:
    root = root.resolve()
    relative = Path(raw)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"path must stay inside the repository: {raw}")
    resolved = (root / relative).resolve()
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise ValueError(f"path escapes the repository: {raw}") from error
    return resolved


def content_digest(root: Path, files: list[str]) -> str:
    digest = hashlib.sha256()
    for raw in sorted(set(files)):
        path = safe_path(root, raw)
        if not path.is_file():
            raise ValueError(f"content file does not exist: {raw}")
        digest.update(raw.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def fields(text: str) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for key, value in FIELD.findall(text):
        found.setdefault(key, []).append(value)
    return found


def one(found: dict[str, list[str]], key: str) -> str:
    values = found.get(key, [])
    if len(values) != 1 or not values[0]:
        raise ValueError(f"receipt requires exactly one non-empty '- {key}:' field")
    return values[0]


def has_section(text: str, aliases: tuple[str, ...]) -> bool:
    return any(re.search(rf"^##\s+{re.escape(alias)}\s*$", text, re.MULTILINE) for alias in aliases)


def verify(root: Path, record_raw: str) -> None:
    record = safe_path(root, record_raw)
    if not record.is_file():
        raise ValueError(f"review receipt does not exist: {record_raw}")
    text = record.read_text(encoding="utf-8")
    found = fields(text)

    brief_raw = one(found, "Brief")
    brief_revision = one(found, "Brief revision")
    expected_digest = one(found, "Content SHA-256")
    author = one(found, "Author").casefold()
    reviewer = one(found, "Reviewer").casefold()
    one(found, "Reviewed at")
    verdict = one(found, "Verdict")
    files = found.get("Content file", [])

    if not files or any(not value for value in files):
        raise ValueError("receipt requires at least one non-empty '- Content file:' field")
    if author == reviewer:
        raise ValueError("author and reviewer must be different")
    if verdict not in {"ready", "validated"}:
        raise ValueError(f"publication gate requires verdict ready or validated, got {verdict}")

    brief = safe_path(root, brief_raw)
    if not brief.is_file():
        raise ValueError(f"brief does not exist: {brief_raw}")
    brief_text = brief.read_text(encoding="utf-8")
    if not re.search(r"^- Status:\s*approved\s*$", brief_text, re.MULTILINE):
        raise ValueError(f"brief is not approved: {brief_raw}")
    revision_match = re.search(r"^- Revision:\s*(\S+)\s*$", brief_text, re.MULTILINE)
    if not revision_match or revision_match.group(1) != brief_revision:
        actual = revision_match.group(1) if revision_match else "missing"
        raise ValueError(f"brief revision is {actual}, receipt records {brief_revision}")

    missing = [aliases[0] for aliases in REQUIRED_SECTIONS if not has_section(text, aliases)]
    if missing:
        raise ValueError(f"receipt is missing sections: {', '.join(missing)}")

    actual_digest = content_digest(root, files)
    if not re.fullmatch(r"[0-9a-f]{64}", expected_digest):
        raise ValueError("Content SHA-256 must be 64 lowercase hexadecimal characters")
    if actual_digest != expected_digest:
        raise ValueError(f"content digest changed: expected {expected_digest}, actual {actual_digest}")

    print(f"{verdict}: {record_raw} ({len(files)} files, {actual_digest})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    digest_parser = subparsers.add_parser("digest", help="print a digest for content files")
    digest_parser.add_argument("files", nargs="+")
    digest_parser.add_argument("--root", default=".")
    verify_parser = subparsers.add_parser("verify", help="verify a review receipt")
    verify_parser.add_argument("record")
    verify_parser.add_argument("--root", default=".")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    try:
        if args.command == "digest":
            print(content_digest(root, args.files))
        else:
            verify(root, args.record)
    except (OSError, UnicodeError, ValueError) as error:
        print(f"content quality gate failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
