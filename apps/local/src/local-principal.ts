import { createMiddleware } from 'hono/factory';

export const LOCAL_USER_ID = 'local-user';
export const DEFAULT_SPACE_ID = 'default-space';

export type LocalPrincipal = {
  mode: 'local';
  userId: string;
  spaceId: string;
  role: 'owner';
};

declare module 'hono' {
  interface ContextVariableMap {
    principal: LocalPrincipal;
  }
}

export const localPrincipal = createMiddleware(async (c, next) => {
  c.set('principal', {
    mode: 'local',
    userId: LOCAL_USER_ID,
    spaceId: DEFAULT_SPACE_ID,
    role: 'owner',
  });

  await next();
});
