import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const localUsers = pgTable('local_users', {
  id: text('id').primaryKey(),
  role: text('role').notNull().default('owner'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const spaces = pgTable('spaces', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => localUsers.id),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workItems = pgTable('work_items', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  status: text('status').notNull().default('waiting'),
  report: jsonb('report').$type<{
    goal: string;
    now: string;
    next: string[];
    openQuestions: string[];
  }>().notNull(),
  revision: integer('revision').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const schema = { localUsers, spaces, projects, workItems };
