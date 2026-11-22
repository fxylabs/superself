/**
 * The answers of the workspace MCP server's record tools, as far as this CLI
 * prints them. Fields a renderer does not read are left out; the server may send
 * more, and a field it adds changes nothing here.
 */

export interface WorkCriterion
{
    ordinal: number;
    text: string;
    coveredAt: string | null;
}

export interface WorkRow
{
    key: string;
    project: string | null;
    summary: string;
    working: string;
    blockedOn: string | null;
    blockedWhy: string | null;
    resolution: string | null;
    evidence: string[];
    criteria: WorkCriterion[];
    priority: string | null;
    assignee: string | null;
    lastEventSeq: number;
}

/** `issue_start` and `issue_show`: who held the issue before, when it is someone else. */
export interface HeldBy
{
    heldBy: string | null;
    heldByMember: string | null;
}

export interface WorkLink
{
    type: string;
    direction: 'from' | 'to';
    key: string;
}

export interface WorkEvent
{
    seq: number;
    type: string;
    at: string;
    annulled: boolean;
}

export interface WorkDetail extends WorkRow, HeldBy
{
    body: string | null;
    links: WorkLink[];
    items: { id: string; name: string }[];
    events: WorkEvent[];
}

export interface Page<Row>
{
    rows: Row[];
    next: string | null;
    count: number;
}

export interface NoteRow
{
    key: string;
    project: string | null;
    summary: string;
    labels: string[];
    status: string;
    visibility: string;
    lastEventSeq: number;
}

export interface NoteDetail extends NoteRow
{
    body: string | null;
    exposure: string;
    placementPriority: number | null;
    links: WorkLink[];
    events: WorkEvent[];
}

export interface RecordListRow
{
    key: string;
    kind: string;
    labels: string[];
    summary: string;
    fragment: string | null;
    project: string | null;
}

export interface RecordList extends Page<RecordListRow>
{
    mode: 'prefix' | 'substring' | null;
}

export type RecordDetail = { kind: 'issue'; issue: WorkDetail } | { kind: 'document'; note: NoteDetail };

export interface UndoAnswer
{
    undone: { seq: number; type: string; key: string };
    row: WorkRow | null;
    note: NoteRow | null;
}

/** The server stops counting past 1,000 and says 1,001. */
export const COUNT_CAP = 1000;
