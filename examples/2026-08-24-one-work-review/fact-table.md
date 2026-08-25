# Fact table

| Claim | Source record | Reader action |
| --- | --- | --- |
| A standalone plan waits for review | `entity.proposed` in `work-history.txt`; pre-accept `work start` refusal recorded in `intro.tape` | run `self work show <id>` before starting |
| Review changed the plan | `review.md`; v1 and v2 events in `work-history.txt` | compare the supported inputs and fragment handling |
| Revision kept one work ID | both history events are under `w-cs7dj` | confirm the ID did not change |
| Acceptance bound v2 | `entity.confirmed` follows `entity.revised` in `work-history.txt` | accept only after the second review passes |
| Work started after acceptance | `entity.started` follows `entity.confirmed` in `work-history.txt` | run `self work start <id>` after acceptance |
| The result is verifiable | settled commit `fea913a2c806` and the report in `work-final.txt` | match the four tests and three checked files to the report |
| Completion was a separate judgment | `entity.done` is the last history event | read the report, then run `self work done <id>` |
