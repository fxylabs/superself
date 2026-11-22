/** `workspace_show`: the one workspace every record command reads and writes. */
export interface WorkspaceShow
{
    workspace: { id: string; name: string; role: string };
}

/** `workspace_switch`: a link, good once and for a few minutes, where the person picks the next workspace. */
export interface SwitchLink
{
    link: string;
    expiresAt: string;
}

export const renderWorkspace = (shown: WorkspaceShow): string =>
    `workspace: ${shown.workspace.name} (${shown.workspace.id}), role ${shown.workspace.role}`;
