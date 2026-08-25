# Source record: one reviewed work unit

This directory preserves the run behind the first Superself tutorial. The
task was a zero-dependency local Markdown link checker in a disposable Git
repository.

## Actual run

- Date: 2026-08-24 KST.
- Agent harness: Codex, in the conversation that produced the tutorial.
- Project: `tutorial-local-docs-check-20260824`.
- Work ID: `w-cs7dj`.
- Baseline commit: `fe66f40`.
- Implementation commit: `fea913a2c806`.
- CLI source: Superself `main` at `5e3cdb7`, built locally. The npm registry
  still returned `0.7.0` without this behavior when the run was recorded.
- Duration: 10 minutes from the v1 proposal at 01:26 UTC to `done` at 01:36
  UTC.

The operator approved the disposable project, requested an independent review,
ordered the two findings applied and reviewed again, accepted v2, then judged
the reported result complete. The prompts were, in order: `ok 승인`, `리뷰
에이전트 돌려`, `수정하고 다시 리뷰 돌려`, `승인`, and `진행`.

## Files

- `work-history.txt`: `self work show w-cs7dj --history` output from the actual
  project after completion. Three empty-event rows had terminal padding removed;
  their text, order and event IDs are unchanged.
- `work-final.txt`: unedited `self work show w-cs7dj` output from the actual
  project after completion.
- `review.md`: the two findings from the first review and the second review's
  disposition.
- `fact-table.md`: the claims admitted into the Korean and English drafts.
- `visuals/work-review-flow.ko.svg` and `visuals/work-review-flow.svg`: Korean
  and English role-and-state maps derived from the actual `w-cs7dj` history
  and final state. They are explanatory diagrams, not product screenshots.
- `visuals/work-review-replay.ko.mp4` and `visuals/work-review-replay.mp4`:
  39-second Korean and English visual replays. Each uses six fixed screens,
  large labels, and state cards derived from the same history. They are
  explanatory media, not product UI or terminal output.
- `visuals/work-review-replay.ko.svg` and `visuals/work-review-replay.svg`:
  the poster frames used by the site player.
- `visuals/render-work-review-replay.mjs`: generates both poster frames and
  MP4 files with ImageMagick and ffmpeg. Run `node
  visuals/render-work-review-replay.mjs visuals` from this directory.
- `repository.bundle`: portable Git history of the disposable repository,
  including baseline `fe66f40` and implementation `fea913a`.
- `tapes/intro.tape`: the full operator recording. It replays the same plan,
  revision reason, acceptance, implementation commit, tests, report and done
  command in an isolated workspace.
- `tapes/review-loop.tape`: a compact review loop for the inline GIF. Its
  setup creates v1 off-camera so the recording starts at the review gate.
- `tapes/intro.gif` and `tapes/intro.mp4`: compact and full outputs of
  `tapes/record.sh`, respectively.

The terminal files remain the raw execution evidence. The tutorial uses the
visual replay because the full plans and report are not legible when a
terminal recording is reduced to article width.

The operator tape has different generated work and event IDs because it is an
isolated replay. It does not reconstruct implementation output: the tape resets
the bundled repository to the actual implementation commit before running the
same tests and attaching that commit as evidence.

No token, email address or internal host appears in the tape or excerpts. The
original `npm test` run inherited an unrelated private-registry warning; the
recording points npm at an empty project-local config so that environment-only
warning is not emitted.
