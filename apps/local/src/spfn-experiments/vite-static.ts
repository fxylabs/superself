import { existsSync } from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';

export type ViteStaticOptions = {
  root?: string;
  entry?: string;
  assetsRoute?: string;
};

/** Mount a Vite production directory onto an existing Hono application. */
export function mountViteStatic(app: Hono, options: ViteStaticOptions = {}): boolean {
  const root = options.root ?? 'dist/web';
  const entry = options.entry ?? 'index.html';
  const assetsRoute = options.assetsRoute ?? '/assets/*';
  const entryPath = path.join(root, entry);
  if (!existsSync(entryPath)) return false;

  app.use(assetsRoute, serveStatic({ root: `./${root}` }));
  app.get('/', serveStatic({ path: `./${entryPath}` }));
  return true;
}
