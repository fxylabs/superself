// The last line in front of `npm publish`, for one package (#430).
//
// `npm publish` uploads a `workspace:` spec verbatim, so a package carrying one
// is installable by nobody. The release gate checks this too, over both
// manifests and before anything uploads — this stands where the mistake would
// actually be made: in the job that publishes, reading the manifest as it is at
// that moment, immediately before the upload.
//
//   node scripts/no-workspace-protocol.mjs apps/cli
import { readManifest, workspaceSpecRefusals } from "./release-gate.mjs";

const directory = process.argv[2];
const refusals = workspaceSpecRefusals(directory, readManifest(directory));
for (const refusal of refusals)
{
    process.stderr.write(`${refusal}\n`);
}
process.exit(refusals.length === 0 ? 0 : 1);
