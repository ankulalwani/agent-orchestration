import fs from 'node:fs';
import path from 'node:path';

/**
 * Routes from file-based routers (QA route discovery, spec §76). Only static routes: a dynamic
 * segment (`[id]`, `$id`, `:id`, `[...slug]`) needs a real value, which only crawling can find.
 */
export function routesFromFiles(root: string): string[] {
  const out = new Set<string>();
  const add = (segments: string[]) => {
    if (segments.some((s) => /^\[.*\]$/.test(s) || s.startsWith('$') || s.startsWith(':'))) return;
    // Route groups `(marketing)` and Remix pathless layouts `_auth` don't appear in URLs.
    const visible = segments.filter((s) => !/^\(.*\)$/.test(s) && !/^_/.test(s) && s !== 'index');
    out.add('/' + visible.join('/'));
  };
  const walk = (dir: string, onFile: (rel: string[]) => void, rel: string[] = []) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), onFile, [...rel, e.name]);
      else onFile([...rel, e.name]);
    }
  };
  const page = /\.(tsx|jsx|ts|js|mdx|md|vue|svelte|astro)$/;

  // Next.js app router: app/**/page.tsx
  for (const base of ['app', 'src/app']) {
    walk(path.join(root, base), (rel) => {
      if (/^page\.(tsx|jsx|ts|js|mdx)$/.test(rel.at(-1)!)) add(rel.slice(0, -1));
    });
  }
  // Next.js pages router, Nuxt: pages/**/*.tsx|vue (not API routes or _app/_document)
  for (const base of ['pages', 'src/pages']) {
    walk(path.join(root, base), (rel) => {
      const file = rel.at(-1)!;
      if (!page.test(file) || rel[0] === 'api' || file.startsWith('_')) return;
      add([...rel.slice(0, -1), file.replace(page, '')]);
    });
  }
  // SvelteKit: src/routes/**/+page.svelte
  walk(path.join(root, 'src', 'routes'), (rel) => {
    if (/^\+page\.svelte$/.test(rel.at(-1)!)) add(rel.slice(0, -1));
  });
  // Remix / React Router v7 flat routes: app/routes/a.b.tsx → /a/b
  walk(path.join(root, 'app', 'routes'), (rel) => {
    if (rel.length !== 1 || !page.test(rel[0]!)) return;
    const name = rel[0]!.replace(page, '').replace(/\[(.+?)\]/g, '$1');
    if (name.startsWith('api.') || name.startsWith('resources.')) return;
    add(name === '_index' ? [] : name.split('.').filter((s) => s !== '_index'));
  });
  return [...out].sort();
}

/** Same-origin page links, without fragments or obvious non-page resources. */
export function sameOriginLinks(hrefs: string[], pageUrl: string): string[] {
  const origin = new URL(pageUrl).origin;
  const out = new Set<string>();
  for (const href of hrefs) {
    let u: URL;
    try {
      u = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (u.origin !== origin || !/^https?:$/.test(u.protocol)) continue;
    if (/\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|css|js|json|xml|txt|woff2?)$/i.test(u.pathname)) continue;
    u.hash = '';
    out.add(u.toString());
  }
  return [...out];
}
