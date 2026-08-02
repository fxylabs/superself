import { AttemptPlan } from "../attempt/plan.js";
import { WorkSpec } from "../spec/workspec.js";

// The categories nothing runs unattended, whatever any policy says.
//
// This is not a capability check — the runner's preflight already owns what an
// attempt may read, write and reach. This is the shorter list of effects that
// leave the machine and cannot be taken back: money moves, a person receives
// something, a package is public, infrastructure exists, bytes are gone, or the
// rules themselves changed. A policy stands in for an operator who is asleep,
// and none of those is a thing an operator can be assumed to have said yes to.
//
// So the list is categorical rather than budgeted: an overnight policy narrows
// what may run and can never widen it, and there is deliberately no flag, no
// risk class and no allow list anywhere in this product that admits one of
// these. The only way past it is a person, awake, doing it themselves.
//
// What this layer is not, said here rather than left to be discovered: it is
// not a security boundary. It reads a declaration — a tool list and an
// invocation — as literal text, and ordinary shell composition walks past it.
// `cu""rl` is not the word curl, a host decoded at runtime is not in the
// command, `/dev/tcp/host/80` names no client, and a fetch assembled from
// character codes says nothing at all. An author who wants past this gets past
// it. It is a fail-closed default against the effect nobody meant to run while
// they were asleep, which is the plainly written one that actually shows up.
// The bound that holds against an author who is trying is the runner's
// preflight — declared reads, writes, domains and secrets, enforced rather
// than read — and this list sits in front of it, not instead of it.
export const FORBIDDEN_ACTIONS = [
    "publish",
    "outreach",
    "payment",
    "purchase",
    "provision",
    "destructive",
    "policy-change"
];

// The words each category is actually declared under. A spec author writes
// `npm-publish`, `deploy` or `send-email`, never the category name, so matching
// only the canonical word would leave the list decorative.
//
// Matching errs closed on purpose: a capability declared as `email-parser` is
// refused, and the refusal names the category so its author can rename it or
// ask a person. The opposite error — a declaration nobody recognised running
// unattended — is the one this whole layer exists to prevent.
const ALIASES: Record<string, string[]> = {
    publish: ["publish", "npm", "release", "announce", "tweet"],
    outreach: ["outreach", "email", "mail", "sms", "dm", "slack", "discord"],
    payment: ["payment", "pay", "charge", "billing", "invoice", "stripe"],
    purchase: ["purchase", "buy", "checkout", "subscribe"],
    provision: ["provision", "deploy", "terraform", "kubectl", "helm", "aws", "gcloud"],
    destructive: ["destructive", "delete", "destroy", "drop", "wipe", "truncate", "rm", "rmrf"],
    "policy-change": ["policy-change", "sudo", "chmod", "escalate", "grant"]
};

// The category a declared action falls into, or null. The whole declaration is
// judged, and so is each word it is built from: `npm-publish` and `publishPkg`
// are the same ask under two spellings.
export function forbiddenAction(action: string): string | null
{
    return wordMatch(action)?.category ?? null;
}

// The category and the word that put it there. A tool name is short enough to
// quote back whole; a command is not, and a refusal that quoted a whole shell
// invocation would be a paragraph carrying this machine's paths in it.
interface WordMatch
{
    word: string;
    category: string;
}

function wordMatch(action: string): WordMatch | null
{
    const normalized = action.trim().toLowerCase();
    const words = [normalized.replace(/[^a-z0-9]/g, ""), ...wordsOf(action)];
    for (const [category, aliases] of Object.entries(ALIASES))
    {
        if (normalized === category)
        {
            return { word: normalized, category };
        }
        const word = words.find((part) => aliases.includes(part));
        if (word !== undefined)
        {
            return { word, category };
        }
    }
    return null;
}

// The words a declaration is built from, however it was cased or separated:
// `npm-publish`, `npm_publish` and `npmPublish` all arrive as two. Split before
// lowercasing, or a camel hump is not a boundary any more.
function wordsOf(action: string): string[]
{
    return action
        .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
        .map((word) => word.toLowerCase())
        .filter((word) => word !== "");
}

export interface ForbiddenMatch
{
    action: string;
    category: string;
}

// What a declaration says it will do, judged. The tools a plan or a spec names
// are the one place a run states its own effects — everything else in either is
// a bound on effects the runner enforces — so that is what is read here.
export function forbiddenTools(tools: unknown): ForbiddenMatch | null
{
    if (!Array.isArray(tools))
    {
        return null;
    }
    for (const tool of tools)
    {
        const category = typeof tool === "string" ? forbiddenAction(tool) : null;
        if (category !== null)
        {
            return { action: String(tool), category };
        }
    }
    return null;
}

// The other half of what a run declares about itself. A capability list is a
// bound on what the run may reach; the command is the invocation that reaches
// it, and it is sealed declared bytes exactly like the rest — so a spec that
// names no tools at all and posts a charge through `curl` has declared a
// payment, whatever its tool list left out. Reading only the tools made the
// categorical list opt-in: an author who declared nothing was judged as having
// asked for nothing.
//
// What is read is the invocation, not everything the invocation carries —
// `invocation()` below is where that line is drawn and what it costs.
export function forbiddenCommand(command: unknown): ForbiddenMatch | null
{
    const reading = invocation(command);
    for (const token of reading.words)
    {
        const match = wordMatch(token);
        if (match !== null)
        {
            return { action: match.word, category: match.category };
        }
    }
    // Vocabulary first, because a named effect is the more useful sentence.
    // What is left is text this gate bounded itself out of reading, and the
    // answer to that is a refusal: 256 harmless words followed by `publish`
    // came back as "nothing forbidden here", which is the one thing a
    // categorical gate may never say about text it did not look at.
    return reading.unread === null ? null : { action: reading.unread, category: UNREADABLE };
}

// Not a category of effect — a statement that the effects could not be
// established. It is kept out of FORBIDDEN_ACTIONS for that reason: nothing
// declares itself unreadable, and no policy surface should offer it as a class.
export const UNREADABLE = "unreadable";

// The tokens of a command array that state what it will do, with the payload
// it merely carries left out.
//
// A command array is one invocation rather than a document. argv[0] is the
// program, and what follows is either part of the invocation — a subcommand, a
// flag, a path, a URL — or an argument only the program itself knows how to
// read. In this product that argument is usually an agent prompt: a real plan
// here is ["claude", "-p", "<thousands of words of English>", "--model", …],
// and English contains "release", "checkout", "delete" and "grant" in their
// ordinary senses. Matching a table of program names against prose refuses
// legitimate work, and this list has no override by design — so a false
// positive here has no recovery except rewording somebody's prompt.
//
// The line: a token with whitespace in it was quoted to arrive as one
// argument, which is what a payload looks like and what an invocation token
// never is. The one exception is a shell's -c script, which is not carried
// anywhere — it is invocation text this machine executes word for word, and it
// is exactly where a command that declares nothing else hides a charge posted
// with `curl`.
//
// What the line gives up, stated rather than found out later:
//   - a payload that is a single word ("deploy") is still read as invocation,
//     because nothing tells it apart from a subcommand;
//   - a shell script that itself carries a prompt — sh -c "claude -p '…'" — is
//     read as code, so a word in that prose can still refuse it. Written as
//     ["claude", "-p", …] the same plan is payload again, which is how every
//     real plan in this product is written;
//   - a payload in another language (node -e, python -c) is not read at all.
//     This table is program and verb vocabulary, which is what shell words are
//     and what program source is not, and matching it against source would
//     produce noise rather than signal. What such a run may reach is the
//     capability declaration's statement and the runner's preflight enforces it.
function invocation(command: unknown): Reading
{
    const reading = respliced(tokens(command).map((text) => ({ text, split: false })));
    const argv = reading.words.map((word) => word.text);
    const script = shellScript(argv);
    // A word this module produced by splitting is invocation text by
    // construction — env was going to re-split it too — so the payload rule
    // does not apply to it. Without this, `env -S "'npm publish'"` split to one
    // word that still carried a space, and the very filter that keeps an
    // agent's prose out of the vocabulary dropped the only word stating the
    // effect. The marker is only ever set by the env reading below, so no other
    // program's argument can escape the payload rule through it.
    return {
        words: reading.words
            .filter((word, index) => index === 0 || index === script || word.split || !/\s/.test(word.text))
            .map((word) => judged(word.text)),
        unread: reading.unread
    };
}

// What one command's invocation text came to, and whether any of it was left
// unread. `unread` is never an admission: a gate that bounds its own work has
// to say so rather than answer "nothing forbidden here" about text it never
// looked at.
interface Reading
{
    words: string[];
    unread: string | null;
}

// A token of the vector being read, and whether this module produced it by
// splitting one that env would have re-split itself.
interface Word
{
    text: string;
    split: boolean;
}

// `env -S "FOO=bar sh -c 'npm publish'"` is a whole invocation packed into a
// single argv token: env splits it back into words itself, so the shell, its
// flag and its script are all inside something a scan over tokens sees as one
// opaque payload — and the gate read nothing at all.
//
// The reading belongs to env and to nothing else. A short cluster containing an
// uppercase S is `-S` on env and somebody else's flag everywhere else: `git -S`
// signs a commit and `sort -S` sizes a buffer, and treating either one's
// argument as invocation text turned an ordinary commit message into a refusal
// nobody could get past. So the flag is honoured only inside an env invocation,
// found by the same basename judgement the rest of this module uses — which is
// why `/usr/bin/env` and a bare `env` behind `sudo` or `xargs` are all covered.
const SPLIT_INLINE = /^--split-string=([\s\S]*)$/;
const ENV = "env";

// env's own option grammar, modelled rather than approximated. Three earlier
// readings guessed at it and each guess was wrong in both directions at once,
// so this states the machine:
//
//   The window OPENS only where env is the program being run — argv[0], or the
//   program token of a launcher that execs it. A token that merely says "env"
//   somewhere in a command's arguments opens nothing: `echo env -S "release
//   notes"` and `git log env -S "release notes"` are ordinary commands.
//
//   Inside it, env's options are read the way env reads them. A flag that takes
//   a separate value consumes the next token, and that token is neither the
//   program nor a packed script — missing this let `env -u FOO -S "…"` walk
//   straight past the gate, because the value cleared the window before the
//   split flag was reached.
//
//   The window CLOSES at `--`, after which the next token is the program
//   whatever it looks like, and at the first token that is neither an option,
//   an option's consumed value, nor a NAME=value assignment. After it closes a
//   `-S` belongs to the program: `env -- -S "release notes"` runs a program
//   called `-S`, and `git -S` signs a commit.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// env's long options, by whether they take a value and how.
const ENV_LONG_VALUE = ["--unset", "--chdir", "--block-signal", "--default-signal", "--ignore-signal"];
const ENV_LONG_BARE = ["--ignore-environment", "--null", "--debug", "--help", "--version"];
const SPLIT_LONG = "--split-string";

// env's short options. `u` and `C` take a value — the rest of the cluster when
// there is one, the next token when there is not — and `S` takes the packed
// command line the same way.
const ENV_SHORT_VALUE = "uC";
const ENV_SHORT_SPLIT = "S";
const ENV_SHORT_BARE = "i0v";

// The launchers verified to hand their program through as separate tokens. They
// are named here only to answer "is the token after them a program position",
// never to decide what is forbidden — that stays positional, so a launcher
// nobody listed still cannot hide a shell.
const LAUNCHERS = ["sudo", "doas", "xargs", "timeout", "nohup", "setsid", "stdbuf", "nice", "ionice", "chrt", "command", "time", "env"];

// A launcher operand that is a number or a duration — `timeout 30`, `nice 10`.
// Anything else bare in front of the program position is the program.
const OPERAND = /^[0-9]+(\.[0-9]+)?[smhd]?$/;

// Bounds on the work this reading may do. Neither is a licence to stop caring
// about what is past it: overflowing either one is reported as unread text and
// refused, because a higher bound has the same defect one word further out.
const MAX_SPLIT_DEPTH = 8;
const MAX_SPLIT_WORDS = 256;

const TOO_MANY_WORDS = `a single argument re-split into more than ${MAX_SPLIT_WORDS} words`;
const TOO_DEEP = `launcher packing nested more than ${MAX_SPLIT_DEPTH} levels deep`;

function respliced(initial: Word[]): { words: Word[]; unread: string | null }
{
    let words = initial;
    let unread: string | null = null;
    for (let splices = 0; splices < MAX_SPLIT_DEPTH; splices++)
    {
        const step = splitOnce(words);
        unread = unread ?? step.unread;
        if (!step.split)
        {
            return { words: step.words, unread };
        }
        words = step.words;
    }
    // The allowed splices are spent. Asked rather than assumed: a chain that
    // needed exactly this many is fully read, and refusing it was the
    // off-by-one that turned a bound into a false refusal.
    const remaining = splitOnce(words);
    return { words, unread: unread ?? (remaining.split ? TOO_DEEP : remaining.unread) };
}

// One pass over the vector, splicing the words out of the packed argument of
// every env invocation it finds.
function splitOnce(words: Word[]): { words: Word[]; split: boolean; unread: string | null }
{
    // Every env in the vector, not only the first. One env launching another is
    // what a packed chain looks like once its outer layer has been spliced, and
    // stopping at the first one left every layer after it unread.
    for (let after = -1; ; )
    {
        const at = envProgram(words, after);
        if (at === -1)
        {
            return { words: [...words], split: false, unread: null };
        }
        const packed = packedArgument(words, at);
        if (packed !== null)
        {
            const split = shellWords(packed.text);
            const out = [...words];
            out.splice(packed.from, packed.count, ...split.words);
            return { words: out, split: true, unread: split.unread };
        }
        // This env runs an ordinary program. The search moves past it, and it
        // strictly increases, so the walk terminates.
        after = at;
    }
}

// Where the next env after `after` is the program being run, or -1. Everything
// before it has to be a launcher, a launcher's option, or a launcher's numeric
// operand: `sudo env` and `timeout 30 env` are env in program position, and
// `echo env` is the word "env" being printed.
function envProgram(words: Word[], after: number): number
{
    let launched = false;
    for (let index = 0; index < words.length; index++)
    {
        const text = words[index].text;
        const name = judged(text);
        if (name === ENV)
        {
            if (index > after)
            {
                return index;
            }
            // An env already looked at is a launcher for whatever follows it.
            launched = true;
            continue;
        }
        if (LAUNCHERS.includes(name))
        {
            launched = true;
            continue;
        }
        if (text.startsWith("-") || ASSIGNMENT.test(text) || (launched && OPERAND.test(text)))
        {
            continue;
        }
        // The program, and it is not env.
        return -1;
    }
    return -1;
}

// The packed command line inside one env invocation: which tokens to replace
// and with what. Null when this env runs an ordinary program.
function packedArgument(words: Word[], at: number): { from: number; count: number; text: string } | null
{
    let index = at + 1;
    while (index < words.length)
    {
        const text = words[index].text;
        // The option terminator. Whatever follows is the program, `-S` or not.
        if (text === "--")
        {
            return null;
        }
        const inline = SPLIT_INLINE.exec(text);
        if (inline !== null)
        {
            return { from: index, count: 1, text: inline[1] };
        }
        if (text === SPLIT_LONG)
        {
            return index + 1 < words.length ? { from: index, count: 2, text: words[index + 1].text } : null;
        }
        const step = envOption(text);
        if (step === null)
        {
            // Not an option and not an assignment: the program env will exec.
            return null;
        }
        if (step.split)
        {
            // Attached to the flag (`-Ssh -c npm publish`) or the token after
            // it. env accepts both, and reading only the second left the first
            // delivering a whole command line nobody looked at.
            if (step.attached !== null)
            {
                return { from: index, count: 1, text: step.attached };
            }
            return index + 1 < words.length ? { from: index, count: 2, text: words[index + 1].text } : null;
        }
        index += step.consumes;
    }
    return null;
}

// How one of env's own option tokens is read: how many tokens it takes, and
// whether it is the one that packs a command line. Null means the token is not
// an option of env's at all.
function envOption(text: string): { consumes: number; split: boolean; attached: string | null } | null
{
    if (ASSIGNMENT.test(text))
    {
        return { consumes: 1, split: false, attached: null };
    }
    if (text.startsWith("--"))
    {
        const name = text.split("=")[0];
        if (ENV_LONG_VALUE.includes(name))
        {
            return { consumes: text.includes("=") ? 1 : 2, split: false, attached: null };
        }
        return ENV_LONG_BARE.includes(name) ? { consumes: 1, split: false, attached: null } : null;
    }
    if (!text.startsWith("-") || text.length < 2)
    {
        return null;
    }
    return shortCluster(text.slice(1));
}

// A short cluster, read left to right the way env reads it. `u`, `C` and `S`
// all take the rest of the cluster as their value when there is one, and the
// next token when the cluster ends at them — so `-Ssh -c npm publish` and
// `-S "sh -c npm publish"` are the same delivery in two spellings.
function shortCluster(cluster: string): { consumes: number; split: boolean; attached: string | null } | null
{
    for (let index = 0; index < cluster.length; index++)
    {
        const letter = cluster[index];
        const rest = cluster.slice(index + 1);
        if (ENV_SHORT_SPLIT.includes(letter))
        {
            return { consumes: rest === "" ? 2 : 1, split: true, attached: rest === "" ? null : rest };
        }
        if (ENV_SHORT_VALUE.includes(letter))
        {
            return { consumes: rest === "" ? 2 : 1, split: false, attached: null };
        }
        if (!ENV_SHORT_BARE.includes(letter))
        {
            return null;
        }
    }
    return { consumes: 1, split: false, attached: null };
}

// Shell word splitting, for reading only. One forward pass, so it terminates on
// any input; an unterminated quote ends with the word it was building rather
// than throwing, because a vector this cannot parse is still a vector this has
// to answer about. Newlines are whitespace, as they are to a shell.
function shellWords(text: string): { words: Word[]; unread: string | null }
{
    const words: Word[] = [];
    let word = "";
    let quote: string | null = null;
    let started = false;
    let truncated = false;
    // A word is only lost when one more actually starts. Marking the bound
    // itself as unread refused exactly 256 fully parsed words for text that was
    // read from end to end.
    const keep = (): boolean =>
    {
        if (words.length >= MAX_SPLIT_WORDS)
        {
            truncated = true;
            return false;
        }
        words.push({ text: word, split: true });
        word = "";
        started = false;
        return true;
    };
    for (let index = 0; index < text.length && !truncated; index++)
    {
        const character = text[index];
        if (character === "\\" && quote !== "'" && index + 1 < text.length)
        {
            word += text[++index];
            started = true;
        }
        else if (quote === null && (character === "'" || character === "\""))
        {
            quote = character;
            started = true;
        }
        else if (character === quote)
        {
            quote = null;
        }
        else if (quote === null && /\s/.test(character))
        {
            if (started)
            {
                keep();
            }
        }
        else
        {
            word += character;
            started = true;
        }
    }
    if (started && !truncated)
    {
        keep();
    }
    // Truncation is a statement about what was not read, not a quiet ceiling.
    // A packed argument of 256 safe words and a forbidden one after them used
    // to come back as "nothing forbidden here".
    return { words, unread: truncated ? TOO_MANY_WORDS : null };
}

// The shells whose -c argument is a script rather than a payload, and the flags
// that say so: `-c`, and the combined forms a wrapper writes like `-lc`.
const SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "ash"];
const SHELL_C = /^-[a-z]*c$/;

// Where the script sits in the argument vector, or -1 when this command is not
// a shell being handed one.
//
// The shell is looked for anywhere in the vector rather than at argv[0]. A
// launcher in front of it — `env FOO=bar sh -c …`, `nice -n 10 bash -lc …`,
// `timeout 30 sh -c …`, `nohup`, `setsid`, `stdbuf`, a container shim — moves
// the shell one or several places along, and reading only the first token made
// the whole -c script a payload again: `["env", "FOO=bar", "sh", "-c", "npm
// publish"]` matched nothing at all, while the identical command without `env`
// was refused.
//
// Searching instead of enumerating launchers is the point. A list of launcher
// names is a list somebody has to keep complete, and the one that is missing
// from it is the one an author reaches for; a shell handed a -c script is what
// actually has to be read, wherever it sits. The cost is erring closed on a
// vector that merely contains a shell's name and a -c-shaped flag after it,
// which is the direction this whole list already errs in.
function shellScript(argv: string[]): number
{
    const shell = argv.findIndex((token) => SHELLS.includes(judged(token)));
    if (shell === -1)
    {
        return -1;
    }
    const flag = argv.findIndex((token, index) => index > shell && SHELL_C.test(token));
    return flag === -1 ? -1 : flag + 1;
}

function tokens(command: unknown): string[]
{
    return Array.isArray(command) ? command.filter((token): token is string => typeof token === "string") : [];
}

// A token is a path when it is one filesystem name and nothing else. A shell
// script has spaces in it and a bare URL has no leading slash, and neither is
// a program this machine happens to store somewhere.
const PATH_TOKEN = /^(?:\.{0,2}|~)\/\S*$/;

// An absolute or relative path is judged by its last segment. The directories a
// program happens to sit under on somebody's machine are not a declaration — a
// node binary inside a checkout called `deploy-tools` says nothing about what
// the run does — while `/usr/local/bin/aws` says everything.

function judged(token: string): string
{
    return PATH_TOKEN.test(token) ? token.slice(token.lastIndexOf("/") + 1) : token;
}

// The clients and the schemes a command reaches the network with. This is not a
// forbidden category — reaching the network is ordinary — it is what tells the
// risk class the truth when the capability declaration left it out.
const NETWORK_WORDS = ["curl", "wget", "ssh", "scp", "sftp", "rsync", "netcat", "telnet", "ftp", "http", "https"];

// Whether the command itself reaches off this machine. The runner builds its
// boundary from declared domains, so a spec that declares none and curls a host
// it never named is not internal risk — it is the case the declaration failed
// to state, and narrowing is the only honest way to guess.
//
// Read over the invocation for the same reason the forbidden list is: a URL
// quoted inside an agent's prompt is a thing the prompt mentions, and a run
// that is judged external for citing an issue link would be refused by every
// default policy for the rest of the night.
export function commandReachesNetwork(command: unknown): boolean
{
    const reading = invocation(command);
    // Unread text is assumed to reach off this machine, for the same reason the
    // forbidden list refuses it: narrowing is the only honest way to guess, and
    // this answer only ever narrows what a policy will run.
    return reading.unread !== null || reading.words.some(reaches);
}

function reaches(token: string): boolean
{
    return token.includes("://") || wordsOf(token).some((word) => NETWORK_WORDS.includes(word));
}

export function forbiddenDeclaration(plan: AttemptPlan): ForbiddenMatch | null
{
    return forbiddenTools(plan.capabilities.tools) ?? forbiddenCommand(plan.command);
}

// The same two questions asked of a sealed generation, so the wake set and the
// registration edge judge one declaration rather than two.
export function forbiddenSpec(spec: WorkSpec): ForbiddenMatch | null
{
    return forbiddenTools(spec.capabilities.tools) ?? forbiddenCommand(spec.command);
}

// One sentence, said the same way wherever the refusal lands: at registration,
// at a mid-run proposal, and in the wake set. A refusal that read differently
// in each place would look like three rules rather than one.
export function forbiddenRefusal(match: ForbiddenMatch, at: string): string
{
    if (match.category === UNREADABLE)
    {
        return `${at} packs more invocation text than this gate can read (${match.action}) — a command whose effects cannot be established is not one that runs unattended, so write it as an ordinary argument vector`;
    }
    return `${at} declares "${match.action}", which is ${match.category} — external publication, outreach, payment, purchase, ` +
        "cloud provisioning, destructive action and policy change are never done unattended, and no overnight policy can grant one";
}
