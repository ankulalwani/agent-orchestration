import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@ao/core';
import { checkMcpServer, type McpHealth, type McpTarget } from './mcp-health.js';

const log = createLogger('worker-mcp');
const RECHECK_MS = 10 * 60_000;
/** Registry-installed servers are checked at most this often (per definition), not before every session. */
const TASK_CHECK_TTL_MS = 5 * 60_000;

export interface LocalMcpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string[];
  url?: string;
}

/**
 * Keeps MCP server health for this worker (CAP-011):
 * - servers configured on the worker are checked at start, on change and every 10 minutes; only the
 *   healthy ones are advertised (`mcp:<id>`), so the scheduler never routes tasks to a broken one;
 * - servers that come with a task's capabilities are checked before the agent gets them (cached briefly).
 */
export class McpMonitor {
  private health = new Map<string, McpHealth>();
  private taskChecks = new Map<string, McpHealth>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private file: string,
    private onChange: () => void = () => undefined,
    private check: typeof checkMcpServer = checkMcpServer,
  ) {}

  servers(): LocalMcpServer[] {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as LocalMcpServer[];
    } catch {
      return [];
    }
  }

  save(list: LocalMcpServer[]) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(list, null, 2));
    for (const id of this.health.keys()) if (!list.some((s) => s.id === id)) this.health.delete(id);
  }

  healthOf(id: string): McpHealth | null {
    return this.health.get(id) ?? null;
  }

  /** `mcp:<id>` tags for servers whose last check passed. */
  healthyTags(): string[] {
    return this.servers()
      .filter((s) => this.health.get(s.id)?.ok)
      .map((s) => `mcp:${s.id}`);
  }

  async checkOne(id: string): Promise<McpHealth | null> {
    const s = this.servers().find((x) => x.id === id);
    if (!s) return null;
    const before = this.health.get(id)?.ok;
    const h = await this.check({ id: s.id, transport: s.transport, command: s.command, url: s.url });
    this.health.set(id, h);
    if (!h.ok) log.warn({ server: id, err: h.error }, 'MCP server is unhealthy; not advertised');
    if (before !== h.ok) this.onChange();
    return h;
  }

  async checkAll() {
    await Promise.all(this.servers().map((s) => this.checkOne(s.id)));
  }

  start() {
    this.stop();
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), RECHECK_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Health of a server definition supplied with a task (e.g. a registry-installed MCP capability). */
  async checkForTask(t: McpTarget): Promise<McpHealth> {
    const key = JSON.stringify([t.transport, t.command, t.url, t.env]);
    const cached = this.taskChecks.get(key);
    if (cached && Date.now() - Date.parse(cached.checkedAt) < TASK_CHECK_TTL_MS) return cached;
    const h = await this.check(t);
    this.taskChecks.set(key, h);
    return h;
  }
}
