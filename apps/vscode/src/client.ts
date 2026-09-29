/**
 * Minimal Agent Orchestration API client for the VS Code extension, authenticated with a personal API
 * token (`aot_…`). No dependencies: the extension host provides `fetch` (Node 18+).
 */
export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  statusReason: string | null;
  kind?: string;
  projectId: string;
  createdAt: string;
  updatedAt?: string;
  completionReport?: { summary?: string; review?: { verdict: string } } | null;
}
export interface ProjectSummary {
  id: string;
  name: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class OrchestrationClient {
  constructor(
    readonly serverUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.serverUrl.replace(/\/+$/, '')}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? `Request failed (HTTP ${res.status})`);
    return data as T;
  }

  /** The token's organization and role. */
  async whoami() {
    const me = await this.call<{ user: { email: string; name: string }; memberships: Array<{ organizationId: string; organizationName: string; role: string }> }>('GET', '/me');
    const m = me.memberships[0];
    if (!m) throw new ApiError(403, 'This token has no organization');
    return { email: me.user.email, name: me.user.name, organizationId: m.organizationId, organizationName: m.organizationName, role: m.role };
  }

  projects(orgId: string) {
    return this.call<ProjectSummary[]>('GET', `/orgs/${orgId}/projects`);
  }

  async tasks(orgId: string, projectId?: string) {
    const q = new URLSearchParams({ limit: '30', ...(projectId ? { projectId } : {}) });
    return (await this.call<{ items: TaskSummary[] }>('GET', `/orgs/${orgId}/tasks?${q}`)).items;
  }

  createTask(orgId: string, body: Record<string, unknown>) {
    return this.call<TaskSummary>('POST', `/orgs/${orgId}/tasks`, body);
  }
}
