import { createMiddleware } from 'hono/factory';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hostnameFromHostHeader(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export const localSecurity = createMiddleware(async (c, next) => {
  const host = c.req.header('host');
  const hostname = host ? hostnameFromHostHeader(host) : new URL(c.req.url).hostname;
  if (!hostname || !LOOPBACK_HOSTS.has(hostname)) {
    return c.json({ error: 'Local host required' }, 403);
  }

  const fetchSite = c.req.header('sec-fetch-site');
  if (fetchSite === 'cross-site') {
    return c.json({ error: 'Cross-site requests are not allowed' }, 403);
  }

  const origin = c.req.header('origin');
  if (origin && !isLoopbackOrigin(origin)) {
    return c.json({ error: 'Loopback origin required' }, 403);
  }

  if (!SAFE_METHODS.has(c.req.method)) {
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim();
    if (contentType !== 'application/json') {
      return c.json({ error: 'JSON request body required' }, 415);
    }
  }

  await next();
});
