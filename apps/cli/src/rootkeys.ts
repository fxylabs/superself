// The root public keys a trust document is verified against, compiled into
// the CLI. This is the whole of the trust anchor, and it is deliberately small.
//
// There are two trust levels. The keys that sign a **plugin release** are not
// here: they are named in a signed, expiring document the rail serves
// (`trust.ts`), so a leaked release key is withdrawn by publishing a new
// document rather than by shipping a new CLI to every machine on earth. What is
// here is the set of **root** keys, and a root's only job is to sign that
// document. A root changes only with a CLI release, which is what makes it a
// pin rather than a fetched list.
//
// Neither field of a signature block is allowed to influence a decision. `kid`
// selects *among* the records below and can never introduce one, and `alg` is
// compared for equality with the constant the verifier is hard-wired to. There
// is no `--trust-root`, no `--allow-unsigned` and no environment override,
// because an escape hatch here is the whole attack. A test reaches a fixture
// root through the `roots` parameter of `loadTrustDocument`, which no CLI path
// passes.
//
// Public keys are public by nature, so pinning them in the open-source
// repository costs nothing and is the point: a customer can read exactly what
// their CLI will accept. A root rotation ships the new root alongside the old
// in a CLI minor; a document is accepted when **any** pinned root whose window
// covers its `issued_at` signed it, and the old pin is dropped a release later.
//
// This module imports nothing. It is data.

export interface RootKey
{
    kid: string;
    // The raw 32-byte ed25519 public key, base64. Raw rather than SPKI because
    // that is what the verifier rebuilds a KeyObject from, and a DER wrapper
    // here would be a second encoding to keep in step.
    publicKey: string;
    // The window a document's `issued_at` must fall inside. Three years
    // (design §10). A document signed outside it is refused, which is how a
    // retired root stops endorsing anything new without invalidating what it
    // legitimately signed before.
    notBefore: string;
    notAfter: string;
}

// The algorithm, fixed here rather than read from any document — for the trust
// document's own signature and for a plugin release's alike.
export const SIGNATURE_ALG = "ed25519";

// ⚠ DEVELOPMENT ROOT — REPLACED BY THE CEREMONY BEFORE THE FIRST RELEASE ⚠
//
// `dev-root-2026a` is the fixture root the plugin suites sign their trust
// documents with. Its private half is a test fixture in this repository and is
// therefore public: anyone holding it can sign a document that names any
// release key they like, so a CLI published with this record pinned would
// accept a plugin anyone can sign.
//
// The operator's ceremony (design §1.4c, run from superself-apps
// `scripts/release/rootkey-generate.mts` with the network off) produces
// `root-2026a` (active) and `root-2026b` (spare, stored in a different vault).
// The commit that pins them here **replaces** this record — it does not add to
// it — and is recorded as a decision, with both fingerprints published in the
// README. Until that commit lands, `npm run release-keys` refuses to publish:
// the gate fails on an empty list and on any kid beginning `dev-`.
export const ROOT_KEYS: RootKey[] = [
    {
        kid: "dev-root-2026a",
        publicKey: "a+GBIeMIsJ2zFicm7PY+iPakCwaViWObmPGtk/FpTGk=",
        notBefore: "2026-01-01T00:00:00Z",
        notAfter: "2029-01-01T00:00:00Z"
    }
];

// Which pinned record a document's `kid` names, or nothing. A lookup, never a
// construction: an unknown `kid` has no answer here and the caller refuses.
//
// `roots` exists so a test can verify against a fixture root without the
// fixture ever being pinned. No CLI path passes it — the default is the pinned
// set — and no environment variable, flag or file reaches it (cell 171).
export function findRootKey(kid: string, roots: readonly RootKey[] = ROOT_KEYS): RootKey | undefined
{
    return roots.find((root) => root.kid === kid);
}
