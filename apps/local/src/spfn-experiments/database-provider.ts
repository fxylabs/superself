import { setDatabase } from '@spfn/core/db';

/**
 * Temporary compatibility seam for Drizzle PostgreSQL drivers that SPFN can
 * execute at runtime but does not yet accept in its public TypeScript API.
 */
export function installSpfnDatabase(database: unknown): () => void {
  setDatabase(database as never);
  return () => setDatabase(undefined);
}
