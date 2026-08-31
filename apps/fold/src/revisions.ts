// Evidence recorded as a git revision, told from evidence recorded as a note,
// by shape alone. The fold splits one from the other without a repository to
// ask — status and context answer without the project checkout — so this errs
// toward silence: a digit-only value is a date, a build number or a ticket at
// least as often as it is a hash, and reporting one as a vanished commit is the
// failure the split exists to stop.
const LEGACY_REVISION = /^(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{7,40}$/;

export function looksLikeLegacyRevision(value: string): boolean
{
    return LEGACY_REVISION.test(value);
}
