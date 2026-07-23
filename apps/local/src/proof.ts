import path from 'node:path';
import { getDatabase, runInTransaction } from '@spfn/core/db';
import type { LocalDatabase } from './database';
import { openLocalDatabase } from './database';
import { createApp } from './app';
import { openLocalSessionService } from './local-session';
import { resolveBrowserCommand } from './open-browser';
import { projects } from './schema';

const dataDir = path.resolve('.data/proof');
const marker = `proof-${Date.now()}`;

const [macBrowserCommand] = resolveBrowserCommand('http://127.0.0.1:4317', 'darwin');
if (macBrowserCommand !== 'open') throw new Error('macOS browser command proof failed');

let handle = await openLocalDatabase(dataDir);
let sessionService = await openLocalSessionService(dataDir);
let app = createApp({ sessionService });

const unauthorizedResponse = await app.request('/api/local/session');
if (unauthorizedResponse.status !== 401) throw new Error('Unpaired browser was not rejected');

const pairingToken = sessionService.issuePairingToken();
const pairingResponse = await app.request('/api/local/session/pair', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: pairingToken }),
});
if (!pairingResponse.ok) throw new Error(`Browser pairing failed: ${await pairingResponse.text()}`);

const setCookieHeader = pairingResponse.headers.get('set-cookie') ?? '';
if (!setCookieHeader.includes('HttpOnly') || !setCookieHeader.includes('SameSite=Strict')) {
  throw new Error(`Pairing cookie is missing security attributes: ${setCookieHeader}`);
}
const sessionCookie = setCookieHeader.split(';', 1)[0];

const replayResponse = await app.request('/api/local/session/pair', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: pairingToken }),
});
if (replayResponse.status !== 401) throw new Error('Pairing token reuse was not rejected');

function authorizedRequest(pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('cookie', sessionCookie);
  return app.request(pathname, { ...init, headers });
}

const healthResponse = await authorizedRequest('/api/health');
const health = await healthResponse.json() as { ok: boolean; runtime: string };
if (!healthResponse.ok || !health.ok) throw new Error('Hono/SPFN route health proof failed');

const sessionResponse = await authorizedRequest('/api/local/session');
const session = await sessionResponse.json() as { userId: string; spaceId: string; role: string };
if (!sessionResponse.ok || session.userId !== 'local-user' || session.spaceId !== 'default-space') {
  throw new Error('Local principal proof failed');
}

const hostileOriginResponse = await app.request('/api/projects', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: 'https://malicious.example',
  },
  body: JSON.stringify({ name: 'must-not-exist' }),
});
if (hostileOriginResponse.status !== 403) throw new Error('Hostile Origin was not rejected');

const crossSiteResponse = await app.request('/api/projects', {
  headers: { 'sec-fetch-site': 'cross-site' },
});
if (crossSiteResponse.status !== 403) throw new Error('Cross-site fetch metadata was not rejected');

const nonJsonResponse = await app.request('/api/projects', {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: 'must-not-exist',
});
if (nonJsonResponse.status !== 415) throw new Error('Non-JSON mutation was not rejected');

const projectResponse = await authorizedRequest('/api/projects', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: marker }),
});
if (!projectResponse.ok) throw new Error(`Project creation failed: ${await projectResponse.text()}`);
const project = await projectResponse.json() as { id: string; name: string };

const workResponse = await authorizedRequest('/api/work', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ projectId: project.id, title: 'PGlite 재시작 증명' }),
});
if (!workResponse.ok) throw new Error(`Work creation failed: ${await workResponse.text()}`);
const work = await workResponse.json() as { id: string; report: { now: string } };

const updateResponse = await authorizedRequest(`/api/work/${work.id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: '재시작 후에도 완료된 작업', status: 'done' }),
});
if (!updateResponse.ok) throw new Error(`Work update failed: ${await updateResponse.text()}`);
const updatedWork = await updateResponse.json() as { id: string; title: string; status: string; revision: number };
if (updatedWork.status !== 'done' || updatedWork.revision !== 2) {
  throw new Error('Work update proof failed');
}

let defaultSpfnTransaction = 'supported';
try {
  await runInTransaction(async (tx) => {
    await (tx as unknown as LocalDatabase).select().from(projects);
  }, { context: 'local:default-transaction-probe' });
} catch (error) {
  defaultSpfnTransaction = `unsupported: ${error instanceof Error ? error.message : String(error)}`;
}

await handle.close();

handle = await openLocalDatabase(dataDir);
sessionService = await openLocalSessionService(dataDir);
app = createApp({ sessionService });

const restoredResponse = await authorizedRequest(`/api/work/${work.id}`);
const restored = await restoredResponse.json() as {
  id: string;
  title: string;
  status: string;
  revision: number;
  report: { now: string };
} | null;
if (!restoredResponse.ok || restored?.id !== work.id || restored.status !== 'done' || restored.revision !== 2) {
  throw new Error('PGlite persistence proof failed after close/reopen');
}

const globalDb = getDatabase() as unknown as LocalDatabase;
const persistedProjects = await globalDb.select().from(projects);

console.log(JSON.stringify({
  ok: true,
  dataDir,
  routeStack: health.runtime,
  localPrincipal: session,
  localPairing: {
    unpaired: unauthorizedResponse.status,
    paired: pairingResponse.status,
    replay: replayResponse.status,
    httpOnly: setCookieHeader.includes('HttpOnly'),
    sameSiteStrict: setCookieHeader.includes('SameSite=Strict'),
    survivesRestart: restoredResponse.status,
  },
  localhostSecurity: {
    hostileOrigin: hostileOriginResponse.status,
    crossSite: crossSiteResponse.status,
    nonJsonMutation: nonJsonResponse.status,
  },
  browserCommand: macBrowserCommand,
  createdProject: project.id,
  createdWork: work.id,
  updatedWork: {
    title: restored.title,
    status: restored.status,
    revision: restored.revision,
  },
  restoredReport: restored.report.now,
  persistedProjectCount: persistedProjects.length,
  defaultSpfnTransaction,
}, null, 2));

await handle.close();
