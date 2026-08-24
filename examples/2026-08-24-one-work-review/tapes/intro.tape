Output intro.gif
Output intro.mp4
Set Shell bash
Set FontSize 14
Set Width 1400
Set Height 960
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 25ms

Hide
Type "export ROOT=$PWD PS1='$ ' PATH=$PWD/scratch/bin:$PATH XDG_CONFIG_HOME=$PWD/scratch/xdg XDG_STATE_HOME=$PWD/scratch/state NPM_CONFIG_USERCONFIG=$PWD/scratch/npmrc && cd scratch/ws/local-docs-check && clear"
Enter
Show

Type "self work propose 'Add a zero-dependency local Markdown link checker to this repository. Plan: inspect README.md and docs/*.md; add scripts/check-links.mjs to recursively check relative Markdown file targets under README.md and docs/, while ignoring external URLs and same-page anchors; add node:test cases for valid links and missing files; expose npm run check:links and document it; run npm test and npm run check:links; commit the implementation and attach the verification as a self report. Do not access the network or change files outside the checker, its tests, package.json, and README.md.'"
Enter
Sleep 4s

Hide
Type "WORK=$(self work --plain | awk 'NR==1 {print $1}')"
Enter
Show
Type "self work start $WORK"
Enter
Sleep 5s

Type "clear"
Enter
Type "self work revise $WORK 'Add a zero-dependency local Markdown link checker to this repository. Plan: inspect README.md and every Markdown file recursively under docs/**/*.md; add scripts/check-links.mjs to check that relative Markdown file targets exist; for a link to another Markdown file with a #fragment, strip the fragment before resolving the file and do not validate the anchor itself; ignore external URLs and same-page anchors; add node:test cases for valid links, missing files, a nested docs directory, and a cross-file fragment; expose npm run check:links and document its supported scope; run npm test and npm run check:links; commit the implementation and attach the verification as a self report. Do not access the network or change files outside the checker, its tests, package.json, and README.md.' --why 'Review found that v1 did not define cross-file fragment handling and conflicted between docs/*.md and recursive discovery. v2 strips fragments before file lookup, keeps anchor validation out of scope, fixes the supported input to docs/**/*.md, and adds both cases to the test plan.'"
Enter
Sleep 4s

Type "self work show $WORK --history"
Enter
Sleep 9s

Type "clear"
Enter
Type "self work accept $WORK"
Enter
Sleep 3s
Type "self work start $WORK"
Enter
Sleep 7s

Hide
Type "git reset -q --hard fea913a"
Enter
Show
Type "clear"
Enter
Type "npm test"
Enter
Sleep 8s
Type "npm run check:links"
Enter
Sleep 5s

Type "self report $WORK 'Implemented the accepted v2 plan in commit fea913a. The zero-dependency checker scans README.md and docs/**/*.md, validates relative Markdown file targets, strips cross-file fragments before file lookup, skips external URLs and same-page anchors, and is exposed as npm run check:links. Four node:test cases cover valid links, missing files, nested docs, and cross-file fragments. Verification passed: npm test (4/4) and npm run check:links (3 Markdown files, all local file links resolve).'"
Enter
Sleep 4s
Type "self work done $WORK"
Enter
Sleep 3s

Type "clear"
Enter
Type "self work show $WORK"
Enter
Sleep 12s
