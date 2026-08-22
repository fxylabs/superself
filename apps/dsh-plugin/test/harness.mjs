// A fake `self` on a private PATH, and a scratch project tree with a `.self`
// marker. Every test runs the real runner against these, never the user's
// installed self or workspace.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const FAKE_SELF = `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === "big")
{
    process.stdout.write("x".repeat(Number(argv[1])));
    process.exit(0);
}
if (argv[0] === "fail")
{
    process.stderr.write("  refused: " + argv.slice(1).join(" ") + "  \\n");
    process.exit(2);
}
const answer = () => console.log(JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid }));
if (argv[0] === "slow")
{
    setTimeout(answer, Number(argv[1]));
}
else
{
    answer();
}
`;

// The fake binary is a node script behind a shebang, so the child's PATH has
// to reach the node that runs the tests as well as the fake itself.
export function scratch()
{
    // macOS hands out /var/… for a path whose real form is /private/var/…; the
    // child reports the real one, so compare against it.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-plugin-superself-")));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "self"), FAKE_SELF);
    chmodSync(join(bin, "self"), 0o755);
    const project = join(root, "project");
    mkdirSync(join(project, "src", "deep"), { recursive: true });
    writeFileSync(join(project, ".self"), "");
    const outside = join(root, "outside");
    mkdirSync(outside);
    const env = { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, HOME: root };
    return { root, bin, project, deep: join(project, "src", "deep"), outside, env };
}

export function parse(outcome)
{
    const [first] = outcome.text.split("\n");
    return JSON.parse(first);
}
