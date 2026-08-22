// The public keys a plugin release is verified against, compiled into the CLI.
//
// This is the whole of the trust anchor. A plugin document arrives over the
// network carrying its own `kid` and its own `alg`, and neither is allowed to
// influence the decision: `kid` selects *among* the records below and can never
// introduce one, and `alg` is compared for equality with the constant the
// verifier is hard-wired to. There is no `--trust-key`, no `--allow-unsigned`
// and no environment override, because an escape hatch here is the whole
// attack.
//
// Public keys are public by nature, so pinning them in the open-source
// repository costs nothing and is the point: a customer can read exactly what
// their CLI will accept. Rotation ships a new key in a new CLI minor with
// overlapping validity; a retired key keeps its `notAfter` so plugins already
// installed under it still verify. A key is never fetched at runtime — a
// fetched key set is not a pin.
//
// This module imports nothing. It is data.

interface ReleaseKey
{
    kid: string;
    // The raw 32-byte ed25519 public key, base64. Raw rather than SPKI because
    // that is what the verifier rebuilds a KeyObject from, and a DER wrapper
    // here would be a second encoding to keep in step.
    publicKey: string;
    // The window a release's `released_at` must fall inside. A signature that
    // verifies against a key whose window excludes the release is refused: it
    // is how a compromised key stops covering anything published after the
    // compromise without invalidating what it legitimately signed before.
    notBefore: string;
    notAfter: string;
}

// The algorithm, fixed here rather than read from any document.
export const RELEASE_SIGNATURE_ALG = "ed25519";

// ⚠ DEVELOPMENT KEY — ROTATE BEFORE THE FIRST PUBLIC RELEASE ⚠
//
// `dev-2026a` is the keypair generated for PR7's own tests and for the
// superself-apps CI signing step while the release pipeline is being built. Its
// private half is a test fixture in both repositories and is therefore public.
// It is here so the loader has something real to verify against end to end; it
// is NOT a production trust anchor, and shipping the CLI with only this key
// would mean anyone holding the fixture can sign a plugin this CLI accepts.
//
// The release checklist replaces this record with a key whose private half
// exists only in superself-apps release CI, and keeps this one only if already
// dev-signed artifacts must keep verifying — which they must not.
export const RELEASE_KEYS: ReleaseKey[] = [
    {
        kid: "dev-2026a",
        publicKey: "y/tV2B9W5IhPHM89i6r0aosTvc/fS5jaHy0xB3aikIo=",
        notBefore: "2026-01-01T00:00:00Z",
        notAfter: "2027-01-01T00:00:00Z"
    }
];

// Which pinned record a document's `kid` names, or nothing. A lookup, never a
// construction: an unknown `kid` has no answer here and the caller refuses.
export function releaseKey(kid: string): ReleaseKey | undefined
{
    return RELEASE_KEYS.find((key) => key.kid === kid);
}
