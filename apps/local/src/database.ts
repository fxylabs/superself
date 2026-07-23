import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { DEFAULT_SPACE_ID, LOCAL_USER_ID } from './local-principal';
import { schema } from './schema';
import { installSpfnDatabase } from './spfn-experiments/database-provider';

export type LocalDatabase = PgliteDatabase<typeof schema>;

export type LocalDatabaseHandle = {
  client: PGlite;
  db: LocalDatabase;
  close(): Promise<void>;
};

export async function openLocalDatabase(dataDir: string): Promise<LocalDatabaseHandle> {
  await mkdir(dataDir, { recursive: true });
  const client = await PGlite.create(path.resolve(dataDir));
  const db = drizzle({ client, schema });

  await db.execute(sql.raw(`
    create table if not exists local_users (
      id text primary key,
      role text not null default 'owner',
      created_at timestamptz not null default now()
    )
  `));
  await db.execute(sql.raw(`
    create table if not exists spaces (
      id text primary key,
      owner_id text not null references local_users(id),
      name text not null,
      created_at timestamptz not null default now()
    )
  `));
  await db.execute(sql.raw(`
    insert into local_users (id, role)
    values ('${LOCAL_USER_ID}', 'owner')
    on conflict (id) do nothing
  `));
  await db.execute(sql.raw(`
    insert into spaces (id, owner_id, name)
    values ('${DEFAULT_SPACE_ID}', '${LOCAL_USER_ID}', 'My Local Space')
    on conflict (id) do nothing
  `));
  await db.execute(sql.raw(`
    create table if not exists projects (
      id text primary key,
      space_id text not null references spaces(id) on delete cascade,
      name text not null,
      created_at timestamptz not null default now()
    )
  `));
  await db.execute(sql.raw(`
    alter table projects add column if not exists space_id text references spaces(id) on delete cascade
  `));
  await db.execute(sql.raw(`
    update projects set space_id = '${DEFAULT_SPACE_ID}' where space_id is null
  `));
  await db.execute(sql.raw(`
    alter table projects alter column space_id set not null
  `));
  await db.execute(sql.raw(`
    create table if not exists work_items (
      id text primary key,
      project_id text not null references projects(id) on delete cascade,
      title text not null,
      status text not null default 'waiting',
      report jsonb not null,
      revision integer not null default 1,
      created_at timestamptz not null default now()
    )
  `));

  const uninstallSpfnDatabase = installSpfnDatabase(db);

  return {
    client,
    db,
    async close() {
      uninstallSpfnDatabase();
      await client.close();
    },
  };
}
