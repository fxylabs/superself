// The publish gate for the pinned trust anchors.
//
// `releasekeys.ts` is the whole of what a customer's CLI will accept, and the
// development key's private half is committed in this repository — so a release
// cut while it is the only pinned record ships a CLI that accepts a plugin
// anyone can sign. A comment saying "rotate before release" is not a gate; this
// is, and it stands in front of `npm publish` rather than in front of every
// build, because pinning only the dev key is the correct state during
// development and the wrong state at exactly one moment.
import { devKeyViolations, diskTree, packageRoot } from "./structure.mjs";

const violations = devKeyViolations(diskTree(packageRoot));
for (const violation of violations)
{
    process.stderr.write(`${violation.file} ${violation.rule} — ${violation.detail}\n`);
}
process.exit(violations.length === 0 ? 0 : 1);
