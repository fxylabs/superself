// The publish gate for the pinned trust anchors.
//
// `rootkeys.ts` is the whole of what a customer's CLI will accept: a root signs
// the key list, and the key list says which keys may sign a plugin. Two states
// must never be published. An **empty** list can accept no key list at all, so
// the CLI it ships in cannot install or load a single mini-app. A **`dev-`**
// root has its private half committed in this repository, so anyone holding the
// fixture can sign a key list naming any release key they like, and that CLI
// will then run a plugin anyone on earth signed.
//
// A comment saying "replace before release" is not a gate; this is, and it
// stands in front of `npm publish` rather than in front of every build, because
// pinning only the development root is the correct state until the operator has
// performed the ceremony and the wrong state at exactly one moment.
//
// It reads **no** environment variable and takes no argument. A skip switch
// would be read in the same shell that runs `npm publish`, so the one command
// this gate exists to stop would be the one command able to turn it off; and a
// development build never reaches here, because nothing but `prepublishOnly`
// runs it.
import { diskTree, packageRoot, rootKeyViolations } from "./structure.mjs";

const violations = rootKeyViolations(diskTree(packageRoot));
for (const violation of violations)
{
    process.stderr.write(`${violation.file} ${violation.rule} — ${violation.detail}\n`);
}
process.exit(violations.length === 0 ? 0 : 1);
