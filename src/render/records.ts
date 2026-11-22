import { COUNT_CAP } from './types';
import type {
    HeldBy, NoteDetail, NoteRow, Page, RecordDetail, RecordList, RecordListRow, UndoAnswer, WorkDetail, WorkEvent, WorkLink, WorkRow,
} from './types';

/**
 * Records as plain text for a person, in the same lines the `self` inside a
 * Superself runtime prints, so an issue reads the same wherever it is read.
 *
 * `query` in a list renderer is the flags the command was given, by name; it
 * makes the next-page line a command that can be run as it is.
 */

// ── shared ────────────────────────────────────────────────────────────────

export const undoLine = (seq: number): string => `undo: self record undo ${seq}`;

const countLine = (count: number): string => `count: ${count > COUNT_CAP ? '1,000+' : count}`;

export const nextPageLine = (command: string, query: Record<string, string>, next: string): string =>
    `next page: self ${[command, ...Object.entries(query).filter(([name]) => name !== 'after')
        .map(([name, value]) => (value === 'true' ? `--${name}` : `--${name} ${shellWord(value)}`)), `--after ${next}`].join(' ')}`;

/** A word as a shell reads it back: bare when it is letters, digits and `-_.:/@`, else in single quotes. */
const shellWord = (word: string): string =>
    /^[\p{L}\p{N}_.:/@-]+$/u.test(word) ? word : `'${word.replaceAll('\'', '\'\\\'\'')}'`;

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

export const renderIssueWritten = (row: WorkRow): string => [renderIssueRow(row), undoLine(row.lastEventSeq)].join('\n');

const heldByLine = (held: HeldBy): string[] =>
    held.heldBy !== null ? [`  held by session ${held.heldBy}`] : held.heldByMember !== null ? [`  held by ${held.heldByMember}`] : [];

export const renderIssueStarted = (answer: WorkRow & HeldBy): string =>
    [renderIssueRow(answer), ...heldByLine(answer), undoLine(answer.lastEventSeq)].join('\n');

export const renderIssueDetail = (detail: WorkDetail): string =>
    [
        renderIssueRow(detail),
        ...heldByLine(detail),
        ...(detail.body === null ? [] : ['', detail.body]),
        ...renderLinks(detail.links),
        ...(detail.items.length === 0 ? [] : ['', 'items:', ...detail.items.map(item => `  ${item.name}  ${item.id}`)]),
        ...renderEvents(detail.events),
    ].join('\n');

export const renderIssueList = (page: Page<WorkRow>, query: Record<string, string>): string =>
{
    if (page.rows.length === 0)
    {
        return query.state === undefined && query.all === undefined
            ? 'no open issues (done and canceled are hidden: --state done|canceled shows them; --all adds deleted ones)'
            : 'no issues match these flags';
    }

    return [
        ...page.rows.map(row => `${row.key}  ${row.working}  ${firstLine(row.summary)}${row.project === null ? '' : `  (${row.project})`}`),
        ...(page.next === null ? [] : [nextPageLine('issue list', query, page.next)]),
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

export const renderNoteWritten = (row: NoteRow): string => [renderNoteRow(row), undoLine(row.lastEventSeq)].join('\n');

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

export const renderNoteList = (page: Page<NoteRow>, query: Record<string, string>): string =>
{
    if (page.rows.length === 0)
    {
        return query.status === undefined && query.all === undefined
            ? 'no current notes (superseded, retracted and undone are hidden; --all shows them)'
            : 'no notes match these flags';
    }

    return [
        ...page.rows.map(renderNoteRow),
        ...(page.next === null ? [] : [nextPageLine('note list', query, page.next)]),
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

/** The words go right after the noun in the next-page command, so `q` is not repeated among its flags. */
export const renderSearch = (answer: RecordList, query: Record<string, string>): string =>
{
    if (answer.rows.length === 0)
    {
        return query.all === undefined
            ? 'no records match (deleted and superseded, retracted, undone notes are hidden: --all shows them)'
            : 'no records match';
    }

    const { q = '', ...flags } = query;
    const command = ['record search', ...(q === '' ? [] : q.split(' ').map(shellWord))].join(' ');

    return [
        ...(answer.mode === 'substring' ? ['no prefix match; showing substring matches'] : []),
        ...answer.rows.flatMap(searchRowLines),
        ...(answer.next === null ? [] : [nextPageLine(command, flags, answer.next)]),
        countLine(answer.count),
    ].join('\n');
};

export const renderUndone = (answer: UndoAnswer): string =>
    [
        `undid ${answer.undone.type} (seq ${answer.undone.seq}) on ${answer.undone.key}`,
        ...(answer.row === null ? [] : [renderIssueRow(answer.row)]),
        ...(answer.note === null ? [] : [renderNoteRow(answer.note)]),
    ].join('\n');
