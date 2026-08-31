// The fold's own refusal. The package cannot construct the CLI's `CliError` —
// that type carries an exit code and a JSON envelope, both of which are facts
// about a command line and not about a log — so a refusal raised while reading
// events is raised as this, and the CLI turns it into one of its own at the
// error boundary. A server does the same with whatever it answers requests in.
export class FoldError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = "FoldError";
    }
}
