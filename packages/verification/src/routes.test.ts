import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { routesFromFiles, sameOriginLinks } from './routes.js';

function project(files: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-routes-'));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), '');
  }
  return root;
}

describe('routes from file-based routers', () => {
  it('Next.js app router: pages, route groups, no dynamic segments or API routes', () => {
    const root = project(['app/page.tsx', 'app/about/page.tsx', 'app/(shop)/cart/page.tsx', 'app/blog/[slug]/page.tsx', 'app/api/health/route.ts', 'app/layout.tsx', 'src/app/docs/page.mdx']);
    expect(routesFromFiles(root)).toEqual(['/', '/about', '/cart', '/docs']);
  });
  it('Next.js pages router and Nuxt', () => {
    const root = project(['pages/index.tsx', 'pages/pricing.tsx', 'pages/_app.tsx', 'pages/api/x.ts', 'pages/users/[id].tsx', 'pages/settings/index.vue']);
    expect(routesFromFiles(root)).toEqual(['/', '/pricing', '/settings']);
  });
  it('SvelteKit and Remix flat routes', () => {
    expect(routesFromFiles(project(['src/routes/+page.svelte', 'src/routes/about/+page.svelte', 'src/routes/post/[id]/+page.svelte', 'src/routes/+layout.svelte']))).toEqual(['/', '/about']);
    expect(routesFromFiles(project(['app/routes/_index.tsx', 'app/routes/about.tsx', 'app/routes/blog.$slug.tsx', 'app/routes/settings.profile.tsx', 'app/routes/_auth.login.tsx', 'app/routes/api.users.ts']))).toEqual(['/', '/about', '/login', '/settings/profile']);
  });
  it('same-origin page links only', () => {
    const links = sameOriginLinks(['/a', '/a#top', 'b', 'https://other.example/x', 'mailto:x@y.z', '/logo.png', 'javascript:void(0)', 'http://app.test/c?q=1'], 'http://app.test/dir/page');
    expect(links).toEqual(['http://app.test/a', 'http://app.test/dir/b', 'http://app.test/c?q=1']);
  });
});
