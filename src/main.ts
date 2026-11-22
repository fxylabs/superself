import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { openableUrl, openInBrowser } from './auth/browser';
import { chooseServer } from './auth/config';
import { login, logout } from './commands/auth';
import type { Io } from './commands/auth';
import { RECORD_COMMANDS } from './commands/records';
import type { Flag, Parsed, RecordCommand } from './commands/records';
import { CliError, EXIT, usage } from './errors';
import type { ExitCode } from './errors';
import { callTool } from './mcp';
import type { Again } from './render/records';
import { renderWorkspace } from './render/workspace';
import type { SwitchLink, WorkspaceShow } from './render/workspace';
import { VERSION } from './version';

/**
 * `self` on a person's own machine: sign in to Superself in the browser, then
 * read and write the records of one workspace through its MCP server.
 */

const SERVER_FLAG: Flag = { name: 'server', type: 'string', value: '<origin>' };

const ACCOUNT_LINES: readonly [string, string][] = [
    ['self login [--server <origin>] [--no-browser]', 'sign in in the browser on this machine and pick the workspace; the sign-in goes to'
        + ' the OS keychain; --no-browser prints the address instead of opening it'],
    ['self logout [--server <origin>]', 'revoke the sign-in at the server and delete it from the keychain'],
    ['self workspace show', 'the workspace the record commands work on'],
    ['self workspace switch', 'pick another workspace in the browser'],
];

const formOf = (command: RecordCommand): string =>
    [`self ${command.noun} ${command.verb}`, command.args,
        ...command.flags.map((flag) =>
        {
            const shown = `--${flag.name}${flag.value === undefined ? '' : ` ${flag.value}`}${flag.multiple === true ? '…' : ''}`;

            return flag.required === true ? shown : `[${shown}]`;
        })].filter(part => part !== '').join(' ');

const help = (noun?: string): string =>
{
    const records = RECORD_COMMANDS.filter(command => noun === undefined || command.noun === noun);
    const account = noun === undefined || noun === 'workspace' || noun === 'login' || noun === 'logout' ? ACCOUNT_LINES : [];

    if (records.length === 0 && account.length === 0) throw usage(`no help for ${noun}: the nouns are issue, note, record, workspace`);

    return [
        ...(noun === undefined ? [`self ${VERSION} — Superself from your own machine`, ''] : []),
        ...account.flatMap(([form, about]) => [form, `    ${about}`]),
        ...(account.length > 0 && records.length > 0 ? [''] : []),
        ...records.flatMap(command => [formOf(command), `    ${command.about}`]),
        ...(noun === undefined
            ? ['', 'Every command takes --server <origin>; without it, the server `self login` last signed in to.',
                'Exit codes: 0 done, 1 this machine could not (keychain, lock, no browser answer), 2 wrong command line,'
                + ' 3 refused or not signed in, 4 server not reached.']
            : []),
    ].join('\n');
};

/** The flags of one command as node's parser wants them, `--server` with them. */
const parseWith = (argv: readonly string[], flags: readonly Flag[], form: string): Parsed =>
{
    const options: NonNullable<ParseArgsConfig['options']> = Object.fromEntries([...flags, SERVER_FLAG].map(flag =>
        [flag.name, { type: flag.type, ...(flag.multiple === true ? { multiple: true } : {}) }]));

    try
    {
        const { values, positionals } = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });

        return { values: values as Parsed['values'], positionals };
    }
    catch (error)
    {
        throw usage(`${error instanceof Error ? error.message : String(error)}\nusage: ${form}`);
    }
};

const serverFlag = (parsed: Parsed): string | undefined =>
    (typeof parsed.values.server === 'string' ? parsed.values.server : undefined);

const runRecord = async (command: RecordCommand, argv: readonly string[]): Promise<string> =>
{
    const form = formOf(command);
    const parsed = parseWith(argv, command.flags, form);
    const count = parsed.positionals.length;
    const fits = 'count' in command.positionals ? count === command.positionals.count : count >= command.positionals.min;
    const missing = command.flags.filter(flag => flag.required === true && parsed.values[flag.name] === undefined);

    if (!fits || missing.length > 0 || parsed.positionals.includes('')) throw usage(`usage: ${form}`);

    const input = command.input(parsed);
    const { server, byFlag } = chooseServer(serverFlag(parsed));
    const again: Again = { server: byFlag ? ` --server ${server}` : '' };

    return command.render(await callTool(server, command.tool, input), parsed, again);
};

const runWorkspace = async (verb: string | undefined, argv: readonly string[], io: Io): Promise<string> =>
{
    if (verb !== 'show' && verb !== 'switch') throw usage('usage: self workspace show|switch [--server <origin>]');

    const parsed = parseWith(argv, [], `self workspace ${verb} [--server <origin>]`);

    if (parsed.positionals.length > 0) throw usage(`usage: self workspace ${verb} [--server <origin>]`);

    const { server } = chooseServer(serverFlag(parsed));

    if (verb === 'show') return renderWorkspace(await callTool(server, 'workspace_show', {}) as WorkspaceShow);

    const { link, expiresAt } = await callTool(server, 'workspace_switch', {}) as SwitchLink;
    const address = openableUrl(link, server);

    io.err('Opening the browser to pick the workspace. If it does not open, open this address:');
    io.err(`  ${address}`);
    openInBrowser(address);

    return `the link works once, until ${expiresAt}; the next command works on the workspace you pick (self workspace show)`;
};

const runAccount = async (verb: 'login' | 'logout', argv: readonly string[], io: Io): Promise<string> =>
{
    const flags: Flag[] = verb === 'login' ? [{ name: 'no-browser', type: 'boolean' }] : [];
    const form = `self ${verb} [--server <origin>]${verb === 'login' ? ' [--no-browser]' : ''}`;
    const parsed = parseWith(argv, flags, form);

    if (parsed.positionals.length > 0) throw usage(`usage: ${form}`);

    return verb === 'login' ? await login(serverFlag(parsed), parsed.values['no-browser'] !== true, io) : await logout(serverFlag(parsed));
};

export const run = async (argv: readonly string[], io: Io): Promise<string> =>
{
    const [noun, verb, ...rest] = argv;

    if (noun === undefined || noun === 'help' || noun === '--help' || noun === '-h') return help(noun === 'help' ? verb : undefined);
    if (noun === '--version' || noun === 'version') return VERSION;
    if (noun === 'login' || noun === 'logout') return await runAccount(noun, argv.slice(1), io);
    if (noun === 'workspace') return await runWorkspace(verb, rest, io);

    const command = RECORD_COMMANDS.find(each => each.noun === noun && each.verb === verb);

    if (command !== undefined) return await runRecord(command, rest);
    if (RECORD_COMMANDS.some(each => each.noun === noun)) throw usage(help(noun));

    throw usage(`unknown command: ${noun}\n\n${help()}`);
};

const io: Io = { out: line => process.stdout.write(`${line}\n`), err: line => process.stderr.write(`${line}\n`) };

const exitCode = await run(process.argv.slice(2), io).then((text): ExitCode =>
{
    if (text !== '') io.out(text);

    return EXIT.ok;
}, (error: unknown): ExitCode =>
{
    if (error instanceof CliError)
    {
        io.err(error.message);

        return error.code;
    }

    io.err(error instanceof Error ? error.message : String(error));

    return EXIT.server;
});

process.exitCode = exitCode;
