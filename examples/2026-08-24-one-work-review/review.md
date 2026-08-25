# Plan review

The first independent review found two material defects before execution:

1. `README.md` already linked to `docs/release.md#before-release`, but v1 did
   not define or test cross-file fragment handling. The review required v2 to
   strip the fragment before checking the file and to state that anchor
   validation stayed out of scope.
2. v1 said both `docs/*.md` and recursive discovery. The review required the
   supported input to be `README.md` plus `docs/**/*.md`, with a nested
   directory test.

The second independent review found no remaining material defect. It made no
file, Git or `self` state changes.
