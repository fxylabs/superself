---
name: content-quality-gate
description: Apply the required brief, independent review, language-specific checks, and publication evidence gate whenever creating, changing, reviewing, or publishing reader-facing content such as landing and marketing pages, product or pricing copy, lifecycle email, docs, tutorials, updates, README or release copy, metadata, calls to action, or explanatory media. Skip internal notes, unchanged verbatim product output, and code-only changes that cannot affect reader-facing meaning or information hierarchy.
---

# Content quality gate

Judge content by whether a defined reader can understand and use it. Do not use human-likeness, an AI detector, a banned-word count, or surface polish as acceptance evidence.

## Classify the work by effect

Use this gate when a change can alter what a reader understands, decides, trusts, or does. File type does not matter. This includes:

- landing, home, product, feature, pricing, sales, contact, and campaign pages;
- public onboarding and lifecycle messages, email, calls to action, forms, and empty states;
- tutorials, documentation, updates, articles, README files, release notes, and repository metadata;
- titles, summaries, search and social metadata, diagrams, screenshots, animation, and video timing or information order; and
- shared components whose copy or visual hierarchy changes several public surfaces.

Skip the gate for internal notes, unedited product or terminal output used as evidence, generated files, and code-only changes that cannot affect public meaning, order, legibility, or action. Legal, security, privacy, accessibility, and financial review remain separate gates when applicable; content review does not replace them.

## Read the project's standard

Look first for `docs/content-planning*.md`, `docs/content-quality-review*.md`, and `docs/content-guide*.md`. Follow the project versions when present. Otherwise use [the review record and fallback rules](references/review-record.md).

State a narrow review contract before production: required reader outcome, affected public surfaces, supported readers and paths, trust boundary, exclusions, and the stop condition for sufficient evidence.

## Gate 1: approved brief before production

A content unit is one reader outcome, not one file. Give it a stable slug and store its brief under the project's content-plan convention.

The brief must identify:

- the reader's product-independent situation;
- what they currently try and where it fails;
- observed facts, separate inferences, and the cheapest disconfirming checks;
- the one decision or action the content should enable;
- the real evidence that supports that change; and
- included surfaces, supported languages, and explicit exclusions.

Creating or reviewing a brief is allowed while its status is `draft` or `review`. Do not create or materially change production copy, visual explanation, or media until the operator marks the brief `approved`. The authoring agent never approves its own brief.

## Produce from evidence

Write each language from the approved brief, fact table, and source records. Do not translate one finished language into another.

For Korean, close the English draft and check for hidden actors, passive and nominalized constructions, repeated connective frames such as `~를 통해` and `~에 대한`, stacked English noun order, and conclusions placed after the action they govern. Treat these as review candidates, not automatic failures. Ask what action the reader understood.

Every sentence and visual must help with at least one job:

- `C`: recognize context;
- `E`: verify evidence;
- `A`: take an action;
- `R`: recognize the result; or
- `D`: make a decision.

Remove an item with no job or one that repeats the same job and information.

## Gate 2: independent `ready` review before publication

Before content becomes deployed, indexed, listed, sent, announced, or otherwise public, a reviewer other than the author must:

1. check claims against source records;
2. follow the supported path at the real viewport and playback speed;
3. check the intended action and expected result;
4. review each language independently; and
5. record findings and the `ready` or `revise` verdict.

Save the receipt under the project's content-review convention. Use the template and verifier in [review-record.md](references/review-record.md). The verifier checks receipt integrity, not content quality; the independent review supplies the judgment.

If no independent reviewer is available or authorized, leave the receipt `revise` or pending and report that publication is blocked. Do not self-certify `ready`.

For a new message, first tutorial, or new visual form, check with five target readers when the project standard requires it. A common starting bar is four of five explaining the central decision and first action, with revision when two fail at the same central point. Record exact misunderstandings and task results rather than satisfaction alone.

## Gate 3: `validated` after real use

`ready` means the pre-publication evidence is sufficient. It does not prove usefulness. Add `validated` only after observing real readers understand, complete, or adopt the intended action. Record questions, incorrect retellings, exits, completion, and next actions. Keep silence as an observation, not a causal explanation.

## Mirrors and adaptations

An unchanged mirror may cite the canonical brief and `ready` receipt when it also verifies byte identity or a deterministic render from the reviewed source. Do not repeat reader research for an unchanged mirror.

A translation, rewrite, local CTA, changed information order, resized visual that changes legibility, or other adaptation is new content for this gate. Review it in its own language and surface.

## Stop when evidence is sufficient

Block on a reachable factual error, unsupported material claim, failed command, missing reader action or result, illegible required evidence, or applicable safety boundary. Record out-of-scope improvements as follow-up and stop once the approved reader outcome has sufficient evidence.
