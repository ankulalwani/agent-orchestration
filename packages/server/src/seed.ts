import { AppError } from '@ao/core';
import { User } from '@ao/database';
import { registerRequest } from '@ao/contracts';
import type { Actor } from './context.js';
import type { Services } from './index.js';

/**
 * Demo data for a new, empty installation (DB-005): `node dist/main.js seed-demo`. Creates the first
 * user (a platform administrator, as the first registration would), an organization, an example
 * project with knowledge, and an example skill. Refuses to touch a database that already has users.
 */
export async function seedDemo(s: Pick<Services, 'auth' | 'projects' | 'capabilities'>, input: { email: string; password: string; name?: string }) {
  if (await User.exists({})) throw new AppError('CONFLICT', 'This database already has users; demo data is only added to a new installation');
  const r = await s.auth.register(registerRequest.parse({ email: input.email, password: input.password, name: input.name ?? 'Administrator', organizationName: 'Demo organization' }));
  const m = r.memberships[0]!;
  const actor: Actor = { userId: r.user.id, organizationId: m.organizationId, role: 'OWNER', correlationId: 'seed-demo', platformAdmin: true };
  const project = await s.projects.create(actor, {
    name: 'Example project',
    description: 'Map it to a folder on a paired worker (Workers → the worker → Projects) to run tasks in it.',
    defaultBranch: 'main',
    environments: [],
    knowledge: 'Run the tests before finishing. Keep changes small and focused; follow the existing code style.',
  });
  await s.capabilities.register(actor, {
    id: 'conventional-commits',
    name: 'Conventional commit summaries',
    version: '1.0.0',
    type: 'skill',
    description: 'Asks agents to summarize their work in the Conventional Commits style.',
    skill: { instructions: 'In the Summary section of your completion report, start with a Conventional Commits line (feat:, fix:, refactor:, docs:, test:, chore:) describing the change.' },
  });
  return { userId: r.user.id, organizationId: m.organizationId, projectId: project.id };
}
