/** Dev helper: map a control-plane project id to a local path on this machine's worker (same as the worker UI "Projects" page). */
import { ConfigStore, LOCAL_UI_TOKEN, createCredentialStore, defaultDataDir } from '../apps/worker/src/index.js';

const [projectId, localPath, name] = process.argv.slice(2);
if (!projectId || !localPath) {
  console.error('usage: tsx scripts/map-worker-project.ts <projectId> <absolutePath> [name]');
  process.exit(1);
}
const dir = defaultDataDir();
const cfg = new ConfigStore(dir).get();
const token = await (await createCredentialStore(dir)).get(LOCAL_UI_TOKEN);
const existing = cfg.projects.filter((p) => p.projectId !== projectId);
const res = await fetch(`http://127.0.0.1:${cfg.localPort}/api/projects`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify([...existing, { projectId, localPath, name }]),
});
console.log(res.status, await res.text());
