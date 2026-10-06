import type { AgentAdapter, AgentInstallation } from './types.js';
import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import { AiderAdapter, CodexAdapter, GeminiAdapter, OpenCodeAdapter } from './adapters/doc-adapters.js';
import { AmpAdapter, AuggieAdapter, ClineAdapter, CodeBuddyAdapter, ContinueAdapter, CopilotAdapter, CrushAdapter, CursorAdapter, DroidAdapter, GrokAdapter, KiloAdapter, KimiAdapter, KiroAdapter, PiAdapter, QoderAdapter, QwenAdapter, TraeAdapter, VibeAdapter } from './adapters/more-adapters.js';
import { MockAgentAdapter } from './adapters/mock.js';

export * from './types.js';
export * from './runtime.js';
export * from './detection.js';
export { ClaudeCodeAdapter, CodexAdapter, GeminiAdapter, OpenCodeAdapter, AiderAdapter, MockAgentAdapter };
export { AmpAdapter, AuggieAdapter, ClineAdapter, CodeBuddyAdapter, ContinueAdapter, CopilotAdapter, CrushAdapter, CursorAdapter, DroidAdapter, GrokAdapter, KiloAdapter, KimiAdapter, KiroAdapter, PiAdapter, QoderAdapter, QwenAdapter, TraeAdapter, VibeAdapter };
export { MOCK_AGENT_SCRIPT } from './adapters/mock.js';
export { GATEWAY_KIND, gatewayLaunch } from './adapters/base.js';

/**
 * Agent manager: registry + cached detection (spec §10). New agents are added by registering an
 * adapter — nothing in the core scheduler or worker knows agent specifics (spec §4).
 */
export class AgentManager {
  private adapters = new Map<string, AgentAdapter>();
  private detected = new Map<string, { at: number; inst: AgentInstallation }>();

  constructor(adapters: AgentAdapter[]) {
    for (const a of adapters) this.register(a);
  }

  register(a: AgentAdapter) {
    this.adapters.set(a.id, a);
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  async detect(id: string, maxAgeMs = 5 * 60_000): Promise<AgentInstallation> {
    const cached = this.detected.get(id);
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.inst;
    const a = this.adapters.get(id);
    if (!a) return { installed: false, path: null, version: null, authenticated: null, notes: ['Unknown agent'] };
    const inst = await a.detect().catch((e: unknown) => ({ installed: false, path: null, version: null, authenticated: null, notes: [String(e)] }));
    this.detected.set(id, { at: Date.now(), inst });
    return inst;
  }

  async inventory() {
    return Promise.all(
      this.list().map(async (a) => {
        const inst = await this.detect(a.id);
        const caps = a.capabilities(inst);
        return {
          id: a.id,
          name: a.name,
          installed: inst.installed,
          version: inst.version,
          path: inst.path,
          authenticated: inst.authenticated,
          supportedProviders: caps.supportedProviders,
          capabilities: Object.entries(caps)
            .filter(([, v]) => v === true)
            .map(([k]) => k),
          notes: [...inst.notes, ...(caps.verification === 'documentation' ? ['Adapter implemented from documentation; not yet verified against this binary'] : [])],
        };
      }),
    );
  }
}

export function defaultAgentManager(opts: { enableMock?: boolean } = {}) {
  const list: AgentAdapter[] = [
    new ClaudeCodeAdapter(), new CodexAdapter(), new GeminiAdapter(), new OpenCodeAdapter(), new AiderAdapter(),
    new CursorAdapter(), new CopilotAdapter(), new KiroAdapter(), new QwenAdapter(), new KimiAdapter(), new GrokAdapter(), new TraeAdapter(),
    new AmpAdapter(), new DroidAdapter(), new AuggieAdapter(), new CrushAdapter(), new ClineAdapter(), new KiloAdapter(), new PiAdapter(),
    new ContinueAdapter(), new QoderAdapter(), new CodeBuddyAdapter(), new VibeAdapter(),
  ];
  if (opts.enableMock) list.push(new MockAgentAdapter());
  return new AgentManager(list);
}
export * from './sandbox.js';
