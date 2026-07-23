import { Hono } from 'hono';
import { registerRoutes } from '@spfn/core/route';
import { setCookie } from 'hono/cookie';
import { localPrincipal } from './local-principal';
import { localSecurity } from './local-security';
import {
  createLocalSessionService,
  LOCAL_SESSION_COOKIE,
  PAIRING_PATH,
  requireLocalSession,
  type LocalSessionService,
} from './local-session';
import { localRouter } from './routes';
import { mountViteStatic } from './spfn-experiments/vite-static';

export function createApp(options: { serveWeb?: boolean; sessionService?: LocalSessionService } = {}) {
  const app = new Hono();
  const sessionService = options.sessionService ?? createLocalSessionService();
  app.use('*', localSecurity);
  app.post(PAIRING_PATH, async (c) => {
    let body: { token?: unknown };
    try {
      body = await c.req.json<{ token?: unknown }>();
    } catch {
      body = {};
    }
    if (typeof body.token !== 'string' || !sessionService.consumePairingToken(body.token)) {
      return c.json({ error: 'Invalid or expired pairing token' }, 401);
    }

    setCookie(c, LOCAL_SESSION_COOKIE, sessionService.browserSessionValue(), {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return c.json({ paired: true });
  });
  app.use('/api/*', requireLocalSession(sessionService));
  app.use('/api/*', localPrincipal);
  registerRoutes(app, localRouter);

  if (options.serveWeb) mountViteStatic(app);

  return app;
}
