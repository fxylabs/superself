# Review record and fallback rules

Use this when the project does not provide a stricter template.

## Files

- Brief: `docs/content-plans/<slug>.<lang>.md`
- Review receipt: `docs/content-reviews/<slug>.<lang>.md`

For a bilingual pair, the project may use `<slug>.md` for Korean and `<slug>.en.md` for English. Keep status, revision, evidence, and decisions aligned while writing each language separately.

## Receipt template

Keep the metadata labels in English so the verifier can read receipts written in any language.

```markdown
# <Content> quality review

- Brief: docs/content-plans/<slug>.<lang>.md
- Brief revision: v0.1
- Content file: path/to/content
- Content file: path/to/another-file
- Content SHA-256: <digest from the verifier>
- Author: <person or agent identity>
- Reviewer: <different person or agent identity>
- Reviewed at: YYYY-MM-DD
- Verdict: revise | ready | validated

## Review scope

Reader outcome, affected surfaces, supported path, trust boundary, exclusions, and stop condition.

## Claims and evidence

Each material claim and its source record, or the reason it is labelled an inference.

## Sentence and visual jobs

| Location | C/E/A/R/D | Reader value | Finding | Action |
| --- | --- | --- | --- | --- |

## Supported-path run

Environment, viewport, commands, expected result, and observed result.

## Independent reviewer answers

Who this is for, what changes for the reader, what proves success, and what can be removed.

## Reader evidence

Required target-reader checks or `Not required` with the project rule that allows reuse of earlier evidence.

## Remaining hypotheses and next check

What is not yet known and the cheapest useful check.

## Sufficient evidence and stop condition

Why the current evidence supports `ready`, or what must change before it can.
```

## Digest and verification

From the repository root, use the script shipped with this skill:

```text
python3 <skill-path>/scripts/verify_review_record.py digest --root . <content-file> [<content-file> ...]
python3 <skill-path>/scripts/verify_review_record.py verify --root . docs/content-reviews/<slug>.<lang>.md
```

The digest covers sorted repository-relative paths and their exact bytes. A content change makes the receipt stale. Re-review the affected outcome, update the receipt, and compute a new digest.

The verifier requires an `approved` brief at the recorded revision, different author and reviewer identities, existing content files, the required review sections, and a matching digest. It accepts only `ready` and `validated` as a passing publication gate. It cannot determine whether the prose is understandable or useful.
