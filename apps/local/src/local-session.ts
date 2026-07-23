import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';

export const LOCAL_SESSION_COOKIE = 'superself_local_session';
export const PAIRING_PATH = '/api/local/session/pair';

const INSTANCE_SECRET_FILE = '.instance-secret';
const SESSION_PURPOSE = 'superself-local-browser-session-v1';
const PAIRING_TTL_MS = 5 * 60_000;

function pairingDigest(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function sessionValue(secret: Uint8Array): string {
  return createHmac('sha256', secret).update(SESSION_PURPOSE).digest('base64url');
}

function equalSecretValue(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export type LocalSessionService = {
  issuePairingToken(): string;
  consumePairingToken(token: string): boolean;
  browserSessionValue(): string;
  verifyBrowserSession(value: string | undefined): boolean;
};

export function createLocalSessionService(secret: Uint8Array = randomBytes(32)): LocalSessionService {
  const pairingTokens = new Map<string, number>();
  const expectedSession = sessionValue(secret);

  return {
    issuePairingToken() {
      const now = Date.now();
      for (const [digest, expiresAt] of pairingTokens) {
        if (expiresAt <= now) pairingTokens.delete(digest);
      }

      const token = randomBytes(32).toString('base64url');
      pairingTokens.set(pairingDigest(token), now + PAIRING_TTL_MS);
      return token;
    },

    consumePairingToken(token) {
      const digest = pairingDigest(token);
      const expiresAt = pairingTokens.get(digest);
      pairingTokens.delete(digest);
      return expiresAt !== undefined && expiresAt > Date.now();
    },

    browserSessionValue() {
      return expectedSession;
    },

    verifyBrowserSession(value) {
      return typeof value === 'string' && equalSecretValue(value, expectedSession);
    },
  };
}

async function readOrCreateInstanceSecret(dataDir: string): Promise<Uint8Array> {
  await mkdir(dataDir, { recursive: true });
  const secretPath = path.join(dataDir, INSTANCE_SECRET_FILE);

  try {
    const value = await readFile(secretPath, 'utf8');
    return Buffer.from(value.trim(), 'base64url');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }

  const secret = randomBytes(32);
  try {
    await writeFile(secretPath, secret.toString('base64url'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    const value = await readFile(secretPath, 'utf8');
    return Buffer.from(value.trim(), 'base64url');
  }

  await chmod(secretPath, 0o600).catch(() => undefined);
  return secret;
}

export async function openLocalSessionService(dataDir: string): Promise<LocalSessionService> {
  return createLocalSessionService(await readOrCreateInstanceSecret(dataDir));
}

export function requireLocalSession(service: LocalSessionService) {
  return createMiddleware(async (c, next) => {
    const session = getCookie(c, LOCAL_SESSION_COOKIE);
    if (!service.verifyBrowserSession(session)) {
      return c.json({ error: 'Local browser pairing required' }, 401);
    }

    await next();
  });
}
