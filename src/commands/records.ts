import {
    renderIssueDetail, renderIssueList, renderIssueStarted, renderIssueWritten, renderNoteDetail, renderNoteList, renderNoteWritten,
    renderRecord, renderSearch, renderUndone,
} from '../render/records';
import type { Again, Typed } from '../render/records';
import type { HeldBy, NoteDetail, NoteRow, Page, RecordDetail, RecordList, UndoAnswer, WorkDetail, WorkRow } from '../render/types';
import { usage } from '../errors';

/**
 * The record commands: issues, notes, and records of either kind. Each is one
 * tool of the workspace MCP server, with the same name (`issue add` is
 * `issue_add`), and the command line is the `self` of a Superself runtime's.
 *
 * What a value may be — a state, a link type, a key's shape — is the server's to
 * judge, and its refusal is printed as it wrote it. This table only reads the
 * command line into the tool's input.
 */

export type FlagType = 'string' | 'boolean';

export interface Flag
{
    name: string;
    type: FlagType;
    multiple?: boolean;
    /** The command cannot be read without it; checked before any call is spent. */
    required?: boolean;
    /** How `self help` shows the value. */
    value?: string;
}

export interface Parsed
{
    positionals: string[];
    values: Record<string, string | boolean | string[] | undefined>;
}

export interface RecordCommand
{
    noun: 'issue' | 'note' | 'record';
    verb: string;
    /** The positionals as `self help` shows them. */
    args: string;
    about: string;
    flags: Flag[];
    /** How many positionals the command takes: exactly, or at least (`min`) with no limit. */
    positionals: { count: number } | { min: number };
    tool: string;
    input: (parsed: Parsed) => Record<string, unknown>;
    render: (answer: unknown, parsed: Parsed, again: Again) => string;
}

// ── reading flags ─────────────────────────────────────────────────────────

const text = (parsed: Parsed, name: string): string | undefined =>
{
    const value = parsed.values[name];

    return typeof value === 'string' ? value : undefined;
};

const texts = (parsed: Parsed, name: string): string[] | undefined =>
{
    const value = parsed.values[name];

    return Array.isArray(value) && value.length > 0 ? value : undefined;
};

const switched = (parsed: Parsed, name: string): true | undefined => (parsed.values[name] === true ? true : undefined);

const integer = (value: string | undefined, name: string): number | undefined =>
{
    if (value === undefined) return undefined;
    if (!/^[0-9]+$/.test(value)) throw usage(`--${name} takes a whole number: ${value}`);

    return Number(value);
};

/** `none` is the command line's word for nobody and for no project; the tool's is `null`. */
const noneAsNull = (value: string): string | null => (value === 'none' ? null : value);

/** An input with the flags that were not given left out, so the server applies its own defaults. */
const given = (input: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

/** A list's flags as they were typed, for the next-page line: a switch stays a switch, a value stays a value. */
const typed = (parsed: Parsed, names: readonly string[]): Typed[] =>
    names.flatMap((name): Typed[] =>
    {
        const value = parsed.values[name];

        return value === true ? [[name, true]] : typeof value === 'string' ? [[name, value]] : [];
    });

const at = (parsed: Parsed, index: number): string => parsed.positionals[index] ?? '';

// ── flags shared by several commands ──────────────────────────────────────

const PAGING: Flag[] = [{ name: 'after', type: 'string', value: '<cursor>' }, { name: 'limit', type: 'string', value: '<n>' }];
const PROJECT: Flag = { name: 'project', type: 'string', value: '<slug>|none' };
const NOTE_WORDS: Flag[] = [
    { name: 'label', type: 'string', multiple: true, value: '<label>' }, { name: 'body', type: 'string', value: '<text>' },
    { name: 'private', type: 'boolean' }, PROJECT,
];

const noteWords = (parsed: Parsed, summary: string): Record<string, unknown> =>
    given({ summary, body: text(parsed, 'body'), labels: texts(parsed, 'label'), private: switched(parsed, 'private'), project: text(parsed, 'project') });

/** A write on one issue: the key, then what the verb adds. */
const onIssue = (verb: string, args: string, about: string, flags: Flag[], count: number,
    input: (parsed: Parsed) => Record<string, unknown>): RecordCommand => ({
    noun: 'issue', verb, args, about, flags, positionals: { count }, tool: `issue_${verb}`,
    input: parsed => ({ key: at(parsed, 0), ...input(parsed) }),
    render: (answer, _parsed, again) => renderIssueWritten(answer as WorkRow, again),
});

const onNote = (verb: string, args: string, about: string, flags: Flag[], count: number,
    input: (parsed: Parsed) => Record<string, unknown>): RecordCommand => ({
    noun: 'note', verb, args, about, flags, positionals: { count }, tool: `note_${verb}`,
    input: parsed => ({ key: at(parsed, 0), ...input(parsed) }),
    render: (answer, _parsed, again) => renderNoteWritten(answer as NoteRow, again),
});

const ISSUE_LIST_FLAGS = ['state', 'project', 'all', 'after', 'limit'] as const;
const NOTE_LIST_FLAGS = ['label', 'project', 'status', 'all', 'after', 'limit'] as const;
const SEARCH_FLAGS = ['kind', 'label', 'project', 'all', 'after', 'limit'] as const;

export const RECORD_COMMANDS: readonly RecordCommand[] = [
    // ── issues ──
    {
        noun: 'issue', verb: 'add', args: '"<summary>"', about: 'record an issue; --criteria repeats for c1..cN',
        flags: [{ name: 'body', type: 'string', value: '<text>' }, { name: 'criteria', type: 'string', multiple: true, value: '<text>' }, PROJECT],
        positionals: { count: 1 }, tool: 'issue_add',
        input: parsed => given({ summary: at(parsed, 0), body: text(parsed, 'body'), criteria: texts(parsed, 'criteria'), project: text(parsed, 'project') }),
        render: (answer, _parsed, again) => renderIssueWritten(answer as WorkRow, again),
    },
    {
        noun: 'issue', verb: 'show', args: '<issue>', about: 'one issue, its criteria and its latest events',
        flags: [], positionals: { count: 1 }, tool: 'issue_show',
        input: parsed => ({ key: at(parsed, 0) }),
        render: answer => renderIssueDetail(answer as WorkDetail),
    },
    {
        noun: 'issue', verb: 'list', args: '', about: 'the workspace\'s issues, a page at a time',
        flags: [{ name: 'state', type: 'string', value: 'backlog|todo|started|blocked|done|canceled|open' }, PROJECT, { name: 'all', type: 'boolean' }, ...PAGING],
        positionals: { count: 0 }, tool: 'issue_list',
        input: parsed => given({
            state: text(parsed, 'state'), project: text(parsed, 'project'), all: switched(parsed, 'all'),
            after: text(parsed, 'after'), limit: integer(text(parsed, 'limit'), 'limit'),
        }),
        render: (answer, parsed, again) => renderIssueList(answer as Page<WorkRow>, typed(parsed, ISSUE_LIST_FLAGS), again),
    },
    onIssue('todo', '<issue>', 'put it in the todo column', [], 1, () => ({})),
    {
        noun: 'issue', verb: 'start', args: '<issue>', about: 'start working on it; says who else holds it',
        flags: [], positionals: { count: 1 }, tool: 'issue_start',
        input: parsed => ({ key: at(parsed, 0) }),
        render: (answer, _parsed, again) => renderIssueStarted(answer as WorkRow & HeldBy, again),
    },
    onIssue('block', '<issue>', 'mark it blocked, on what and why',
        [{ name: 'on', type: 'string', required: true, value: 'decision|dependency|external' }, { name: 'why', type: 'string', required: true, value: '<text>' }], 1,
        parsed => given({ on: text(parsed, 'on'), why: text(parsed, 'why') })),
    onIssue('done', '<issue>', 'close it; criteria covered and evidence needed',
        [{ name: 'evidence', type: 'string', multiple: true, value: '<commit>' }], 1,
        parsed => given({ evidence: texts(parsed, 'evidence') })),
    onIssue('cancel', '<issue>', 'cancel it with a resolution', [{ name: 'resolution', type: 'string', required: true, value: '<slug>' }], 1,
        parsed => given({ resolution: text(parsed, 'resolution') })),
    onIssue('cover', '<issue>', 'mark a criterion covered and say how',
        [
            { name: 'criterion', type: 'string', required: true, value: '<cN>' }, { name: 'why', type: 'string', required: true, value: '<text>' },
            { name: 'evidence', type: 'string', multiple: true, value: '<commit>' }, { name: 'work', type: 'string', value: '<issue>' },
        ], 1,
        parsed => given({ criterion: text(parsed, 'criterion'), why: text(parsed, 'why'), evidence: texts(parsed, 'evidence'), work: text(parsed, 'work') })),
    onIssue('comment', '<issue> "<text>"', 'append text to its body', [], 2, parsed => ({ text: at(parsed, 1) })),
    {
        noun: 'issue', verb: 'evidence', args: '<issue> <commit> [<commit>…]', about: 'add commits to its evidence',
        flags: [], positionals: { min: 2 }, tool: 'issue_evidence',
        input: parsed => ({ key: at(parsed, 0), evidence: parsed.positionals.slice(1) }),
        render: (answer, _parsed, again) => renderIssueWritten(answer as WorkRow, again),
    },
    onIssue('link', '<issue> member-of|supersedes|relates|duplicate-of|blocks <issue>', 'link it to another issue', [], 3,
        parsed => ({ type: at(parsed, 1), to: at(parsed, 2) })),
    onIssue('prioritize', '<issue> urgent|high|medium|low|none', 'set its priority', [], 2, parsed => ({ priority: at(parsed, 1) })),
    onIssue('assign', '<issue> me|<email>|none', 'assign it to yourself, a member, or nobody', [], 2, parsed => ({ to: noneAsNull(at(parsed, 1)) })),
    onIssue('move', '<issue> <slug>|none', 'file it under a project, or none', [], 2, parsed => ({ to: noneAsNull(at(parsed, 1)) })),

    // ── notes ──
    {
        noun: 'note', verb: 'add', args: '"<summary>"', about: 'record a note; --label repeats; --private keeps it to you',
        flags: NOTE_WORDS, positionals: { count: 1 }, tool: 'note_add',
        input: parsed => noteWords(parsed, at(parsed, 0)),
        render: (answer, _parsed, again) => renderNoteWritten(answer as NoteRow, again),
    },
    {
        noun: 'note', verb: 'show', args: '<note>', about: 'one note, its links and its latest events',
        flags: [], positionals: { count: 1 }, tool: 'note_show',
        input: parsed => ({ key: at(parsed, 0) }),
        render: answer => renderNoteDetail(answer as NoteDetail),
    },
    {
        noun: 'note', verb: 'list', args: '', about: 'the workspace\'s notes, a page at a time',
        flags: [
            { name: 'label', type: 'string', value: '<label>' }, PROJECT,
            { name: 'status', type: 'string', value: 'proposed|confirmed|superseded|retracted|undone' }, { name: 'all', type: 'boolean' }, ...PAGING,
        ],
        positionals: { count: 0 }, tool: 'note_list',
        input: parsed => given({
            label: text(parsed, 'label'), project: text(parsed, 'project'), status: text(parsed, 'status'), all: switched(parsed, 'all'),
            after: text(parsed, 'after'), limit: integer(text(parsed, 'limit'), 'limit'),
        }),
        render: (answer, parsed, again) => renderNoteList(answer as Page<NoteRow>, typed(parsed, NOTE_LIST_FLAGS), again),
    },
    onNote('supersede', '<note> "<summary>"', 'replace a note with a new one', NOTE_WORDS, 2, parsed => noteWords(parsed, at(parsed, 1))),
    onNote('retract', '<note>', 'withdraw a note', [], 1, () => ({})),
    onNote('place', '<note>', 'set how far a note is shown unasked, and its order',
        [{ name: 'exposure', type: 'string', value: 'full|index|search' }, { name: 'priority', type: 'string', value: '<n>|none' }], 1,
        (parsed) =>
        {
            const priority = text(parsed, 'priority');

            return given({ exposure: text(parsed, 'exposure'), priority: priority === 'none' ? null : integer(priority, 'priority') });
        }),

    // ── records of either kind ──
    {
        noun: 'record', verb: 'show', args: '<issue>|<note>', about: 'one record of any kind: an issue or a note',
        flags: [], positionals: { count: 1 }, tool: 'record_show',
        input: parsed => ({ key: at(parsed, 0) }),
        render: answer => renderRecord(answer as RecordDetail),
    },
    {
        noun: 'record', verb: 'search', args: '<words>…', about: 'find records of any kind by words',
        flags: [
            { name: 'kind', type: 'string', value: 'document|issue' }, { name: 'label', type: 'string', value: '<label>' }, PROJECT,
            { name: 'all', type: 'boolean' }, ...PAGING,
        ],
        positionals: { min: 0 }, tool: 'record_search',
        input: parsed => given({
            q: parsed.positionals.length === 0 ? undefined : parsed.positionals.join(' '),
            kind: text(parsed, 'kind'), label: text(parsed, 'label'), project: text(parsed, 'project'), all: switched(parsed, 'all'),
            after: text(parsed, 'after'), limit: integer(text(parsed, 'limit'), 'limit'),
        }),
        render: (answer, parsed, again) => renderSearch(answer as RecordList, parsed.positionals, typed(parsed, SEARCH_FLAGS), again),
    },
    {
        noun: 'record', verb: 'undo', args: '<seq>|<issue>|<note>', about: 'reverse one event you recorded',
        flags: [], positionals: { count: 1 }, tool: 'record_undo',
        input: (parsed) =>
        {
            const target = at(parsed, 0);

            return /^[0-9]+$/.test(target) ? { seq: Number(target) } : { key: target };
        },
        render: answer => renderUndone(answer as UndoAnswer),
    },
];
