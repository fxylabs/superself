import { COUNT_CAP } from './types';
import type {
    HeldBy, NoteDetail, NoteRow, Page, RecordDetail, RecordList, RecordListRow, UndoAnswer, WorkDetail, WorkEvent, WorkLink, WorkRow,
} from './types';

/**
 * Records as plain text for a person, in the same lines the `self` inside a
 * Superself runtime prints, so an issue reads the same wherever it is read.
 *
 * A list renderer gets the flags as they were typed, and every renderer that
 * prints a command to run next gets `Again`: the printed line is a command that
 * runs as it is, against the same server.
 */

// ── shared ────────────────────────────────────────────────────────────────

/**
 * How a command this CLI prints for the person to run next is written: `self`,
 * the command, its flags, and `--server <origin>` when the command that printed
 * it was given one — so the line acts on the same server, never the default.
 */
export interface Again
{
    /** ` --server <origin>`, or nothing. */
    server: string;
}

/** A flag as it was typed: a switch, or a value. */
export type Typed = readonly [name: string, value: string | true];

export const undoLine = (seq: number, again: Again): string => `undo: self record undo ${seq}${again.server}`;

const countLine = (count: number): string => `count: ${count > COUNT_CAP ? '1,000+' : count}`;

/** The flags, then `--after`, then the server, then the words; `--` before the words when one starts with `-`. */
export const nextPageLine = (command: string, flags: readonly Typed[], next: string, again: Again, words: readonly string[] = []): string =>
    `next page: self ${[
        command,
        ...flags.filter(([name]) => name !== 'after').map(([name, value]) => (value === true ? `--${name}` : `--${name} ${shellWord(value)}`)),
        `--after ${next}`,
    ].join(' ')}${again.server}${words.length === 0 ? '' : ` ${words.some(word => word.startsWith('-')) ? '-- ' : ''}${words.map(shellWord).join(' ')}`}`;

/** A word as a shell reads it back: bare when it is letters, digits and `-_.:/@`, else in single quotes. */
const shellWord = (word: string): string =>
    /^[\p{L}\p{N}_.:/@-]+$/u.test(word) ? word : `'${word.replaceAll('\'', '\'\\\'\'')}'`;

const given = (flags: readonly Typed[], name: string): boolean => flags.some(([flag]) => flag === name);

const renderLinks = (links: WorkLink[]): string[] =>
    links.length === 0 ? [] : ['', 'links:', ...links.map(link => `  ${link.type} ${link.direction === 'from' ? '→' : '←'} ${link.key}`)];

const renderEvents = (events: WorkEvent[]): string[] =>
    ['', 'events (latest first):', ...events.map(event => `  ${event.seq}  ${event.type}  ${event.at}${event.annulled ? '  (undone)' : ''}`)];

const firstLine = (text: string): string => text.split('\n')[0] ?? '';

// ── issues ────────────────────────────────────────────────────────────────

/** `w-abc12  blocked (blocked on decision: why)  Fix the login  [app]  !high  @a@b.c`, then its criteria and evidence. */
export const renderIssueRow = (row: WorkRow): string =>
{
    const blocked = row.blockedOn === null ? '' : ` (blocked on ${row.blockedOn}: ${row.blockedWhy ?? ''})`;
    const resolution = row.resolution === null ? '' : ` (${row.resolution})`;
    const project = row.project === null ? '' : `  [${row.project}]`;
    const priority = row.priority === null ? '' : `  !${row.priority}`;
    const assignee = row.assignee === null ? '' : `  @${row.assignee}`;

    return [
        `${row.key}  ${row.working}${blocked}${resolution}  ${row.summary}${project}${priority}${assignee}`,
        ...row.criteria.map(criterion => `  c${criterion.ordinal} ${criterion.coveredAt === null ? '·' : '✓'} ${criterion.text}`),
        ...(row.evidence.length === 0 ? [] : [`  evidence: ${row.evidence.join(', ')}`]),
    ].join('\n');
};

export const renderIssueWritten = (row: WorkRow, again: Again): string => [renderIssueRow(row), undoLine(row.lastEventSeq, again)].join('\n');

const heldByLine = (held: HeldBy): string[] =>
    held.heldBy !== null ? [`  held by session ${held.heldBy}`] : held.heldByMember !== null ? [`  held by ${held.heldByMember}`] : [];

export const renderIssueStarted = (answer: WorkRow & HeldBy, again: Again): string =>
    [renderIssueRow(answer), ...heldByLine(answer), undoLine(answer.lastEventSeq, again)].join('\n');

export const renderIssueDetail = (detail: WorkDetail): string =>
    [
        renderIssueRow(detail),
        ...heldByLine(detail),
        ...(detail.body === null ? [] : ['', detail.body]),
        ...renderLinks(detail.links),
        ...(detail.items.length === 0 ? [] : ['', 'items:', ...detail.items.map(item => `  ${item.name}  ${item.id}`)]),
        ...renderEvents(detail.events),
    ].join('\n');

export const renderIssueList = (page: Page<WorkRow>, flags: readonly Typed[], again: Again): string =>
{
    if (page.rows.length === 0)
    {
        return !given(flags, 'state') && !given(flags, 'all')
            ? 'no open issues (done and canceled are hidden: --state done|canceled shows them; --all adds deleted ones)'
            : 'no issues match these flags';
    }

    return [
        ...page.rows.map(row => `${row.key}  ${row.working}  ${firstLine(row.summary)}${row.project === null ? '' : `  (${row.project})`}`),
        ...(page.next === null ? [] : [nextPageLine('issue list', flags, page.next, again)]),
        countLine(page.count),
    ].join('\n');
};

// ── notes ─────────────────────────────────────────────────────────────────

/** `e-abc12  confirmed  Keys are e-  [decision, api]  (app)  private` */
export const renderNoteRow = (row: NoteRow): string =>
{
    const labels = row.labels.length === 0 ? '' : `  [${row.labels.join(', ')}]`;
    const project = row.project === null ? '' : `  (${row.project})`;
    const visibility = row.visibility === 'private' ? '  private' : '';

    return `${row.key}  ${row.status}  ${firstLine(row.summary)}${labels}${project}${visibility}`;
};

export const renderNoteWritten = (row: NoteRow, again: Again): string => [renderNoteRow(row), undoLine(row.lastEventSeq, again)].join('\n');

export const renderNoteDetail = (detail: NoteDetail): string =>
    [
        `${detail.key}  ${detail.summary}`,
        ...(detail.labels.length === 0 ? [] : [`  labels: ${detail.labels.join(', ')}`]),
        `  ${detail.status} · ${detail.exposure} · priority ${detail.placementPriority ?? 'none'} · ${detail.visibility}`,
        ...(detail.project === null ? [] : [`  project: ${detail.project}`]),
        ...(detail.body === null ? [] : ['', detail.body]),
        ...renderLinks(detail.links),
        ...renderEvents(detail.events),
    ].join('\n');

export const renderNoteList = (page: Page<NoteRow>, flags: readonly Typed[], again: Again): string =>
{
    if (page.rows.length === 0)
    {
        return !given(flags, 'status') && !given(flags, 'all')
            ? 'no current notes (superseded, retracted and undone are hidden; --all shows them)'
            : 'no notes match these flags';
    }

    return [
        ...page.rows.map(renderNoteRow),
        ...(page.next === null ? [] : [nextPageLine('note list', flags, page.next, again)]),
        countLine(page.count),
    ].join('\n');
};

// ── records of either kind ────────────────────────────────────────────────

export const renderRecord = (record: RecordDetail): string =>
    record.kind === 'issue' ? renderIssueDetail(record.issue) : renderNoteDetail(record.note);

/** `e-abc12  document  decision,api  Keys are e-  (app)`, then the piece the words matched. */
const searchRowLines = (row: RecordListRow): string[] =>
{
    const line = `${row.key}  ${row.kind}  ${row.labels.length === 0 ? '-' : row.labels.join(',')}  ${row.summary}${row.project === null ? '' : `  (${row.project})`}`;

    return row.fragment === null ? [line] : [line, `    ${row.fragment}`];
};

/** The next page repeats the words as they were given, one argument each, after the flags. */
export const renderSearch = (answer: RecordList, words: readonly string[], flags: readonly Typed[], again: Again): string =>
{
    if (answer.rows.length === 0)
    {
        return !given(flags, 'all')
            ? 'no records match (deleted and superseded, retracted, undone notes are hidden: --all shows them)'
            : 'no records match';
    }

    return [
        ...(answer.mode === 'substring' ? ['no prefix match; showing substring matches'] : []),
        ...answer.rows.flatMap(searchRowLines),
        ...(answer.next === null ? [] : [nextPageLine('record search', flags, answer.next, again, words)]),
        countLine(answer.count),
    ].join('\n');
};

export const renderUndone = (answer: UndoAnswer): string =>
    [
        `undid ${answer.undone.type} (seq ${answer.undone.seq}) on ${answer.undone.key}`,
        ...(answer.row === null ? [] : [renderIssueRow(answer.row)]),
        ...(answer.note === null ? [] : [renderNoteRow(answer.note)]),
    ].join('\n');
