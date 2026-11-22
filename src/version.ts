import { createRequire } from 'node:module';

/** The package's own version, read from its package.json beside `dist/`. */
export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
