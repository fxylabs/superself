import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { getDatabase, runInTransaction } from '@spfn/core/db';
import { defineRouter, route } from '@spfn/core/route';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { LocalDatabase } from './database';
import { projects, workItems } from './schema';

function localDb(): LocalDatabase {
  return getDatabase() as unknown as LocalDatabase;
}

const localSession = route.get('/api/local/session').handler((c) => {
  return c.raw.get('principal');
});

const listProjects = route.get('/api/projects').handler(async (c) => {
  const principal = c.raw.get('principal');
  return localDb()
    .select()
    .from(projects)
    .where(eq(projects.spaceId, principal.spaceId))
    .orderBy(asc(projects.createdAt));
});

const createProject = route.post('/api/projects')
  .input({ body: Type.Object({ name: Type.String({ minLength: 1 }) }) })
  .handler(async (c) => {
    const { body } = await c.data();
    const principal = c.raw.get('principal');
    const id = `project-${randomUUID()}`;

    return runInTransaction(async (tx) => {
      const [project] = await (tx as unknown as LocalDatabase)
        .insert(projects)
        .values({ id, spaceId: principal.spaceId, name: body.name })
        .returning();
      return project;
    }, { timeout: 0, idleTimeout: 0, context: 'local:create-project' });
  });

const createWork = route.post('/api/work')
  .input({
    body: Type.Object({
      projectId: Type.String(),
      title: Type.String({ minLength: 1 }),
    }),
  })
  .handler(async (c) => {
    const { body } = await c.data();
    const principal = c.raw.get('principal');
    const [project] = await localDb()
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, body.projectId), eq(projects.spaceId, principal.spaceId)));
    if (!project) return c.json({ error: 'Project not found in local space' }, 404);

    const id = `work-${randomUUID()}`;
    const [work] = await localDb().insert(workItems).values({
      id,
      projectId: body.projectId,
      title: body.title,
      report: {
        goal: body.title,
        now: '로컬 Hono API가 첫 보고를 만들었습니다.',
        next: ['프로세스를 재시작하고 이 보고를 다시 읽는다.'],
        openQuestions: [],
      },
    }).returning();
    return work;
  });

const listWork = route.get('/api/work').handler(async (c) => {
  const principal = c.raw.get('principal');
  return localDb()
    .select({
      id: workItems.id,
      projectId: workItems.projectId,
      title: workItems.title,
      status: workItems.status,
      report: workItems.report,
      revision: workItems.revision,
      createdAt: workItems.createdAt,
    })
    .from(workItems)
    .innerJoin(projects, eq(workItems.projectId, projects.id))
    .where(eq(projects.spaceId, principal.spaceId))
    .orderBy(asc(workItems.createdAt));
});

const getWork = route.get('/api/work/:id')
  .input({ params: Type.Object({ id: Type.String() }) })
  .handler(async (c) => {
    const { params } = await c.data();
    const principal = c.raw.get('principal');
    const [work] = await localDb()
      .select({
        id: workItems.id,
        projectId: workItems.projectId,
        title: workItems.title,
        status: workItems.status,
        report: workItems.report,
        revision: workItems.revision,
        createdAt: workItems.createdAt,
      })
      .from(workItems)
      .innerJoin(projects, eq(workItems.projectId, projects.id))
      .where(and(eq(workItems.id, params.id), eq(projects.spaceId, principal.spaceId)));
    return work ?? null;
  });

const updateWork = route.patch('/api/work/:id')
  .input({
    params: Type.Object({ id: Type.String() }),
    body: Type.Object({
      title: Type.String({ minLength: 1 }),
      status: Type.Union([
        Type.Literal('waiting'),
        Type.Literal('in-progress'),
        Type.Literal('done'),
      ]),
    }),
  })
  .handler(async (c) => {
    const { params, body } = await c.data();
    const principal = c.raw.get('principal');
    const [ownedWork] = await localDb()
      .select({ id: workItems.id })
      .from(workItems)
      .innerJoin(projects, eq(workItems.projectId, projects.id))
      .where(and(eq(workItems.id, params.id), eq(projects.spaceId, principal.spaceId)));
    if (!ownedWork) return c.json({ error: 'Work not found in local space' }, 404);

    const [updated] = await localDb()
      .update(workItems)
      .set({
        title: body.title,
        status: body.status,
        revision: sql`${workItems.revision} + 1`,
      })
      .where(eq(workItems.id, params.id))
      .returning();
    return updated;
  });

const health = route.get('/api/health').handler(() => ({
  ok: true,
  runtime: 'hono+spfn-route+pglite',
  auth: 'local-principal',
}));

export const localRouter = defineRouter({
  health,
  localSession,
  listProjects,
  createProject,
  listWork,
  createWork,
  getWork,
  updateWork,
});
