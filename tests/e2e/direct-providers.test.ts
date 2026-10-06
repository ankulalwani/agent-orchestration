/**
 * The providers a harness uses directly (not through the model gateway), for real: every (harness,
 * provider kind) pair an adapter declares in `supportedProviders` and that can be run without an account.
 *
 * - Against a local endpoint: the harness gets the provider the way the worker gives it (key, base URL,
 *   model), finishes a task with its own file tool, and the request arrives where the base URL points.
 *   OpenAI-style kinds point at the fake model; `anthropic@named` points at the gateway's Anthropic
 *   endpoint under a model name the harness knows, which shows that the base URL is honoured.
 * - Against the vendor (`<kind>@real`): the vendor's own endpoint with a key it rejects. The outcome must
 *   be AUTH_REQUIRED, which shows that the harness chose that provider, sent our key and that the refusal
 *   is recognised. These make real, rejected requests to OpenAI, Anthropic, Google and OpenRouter.
 *
 * Runs with AO_TEST_AGENT_CLIS=1; harnesses that aren't installed are skipped. Not covered, because they
 * need an account or a server: Azure OpenAI, Bedrock, Vertex, a real Ollama.
 */
import { describe, expect, it } from 'vitest';
import { ADAPTERS, CONTENT, findExecutable, interpret, runThroughGateway } from './gateway-harness.js';

const enabled = process.env.AO_TEST_AGENT_CLIS === '1';
const installed = (agentId: string) => Boolean(findExecutable(ADAPTERS[agentId]!));

const LOCAL: Array<[agent: string, route: string]> = [
  ['copilot', 'openai'],
  ['copilot', 'openai-compatible'],
  ['copilot', 'ollama'],
  ['copilot', 'anthropic'],
  ['qwen', 'openai'],
  ['qwen', 'openai-compatible'],
  ['trae', 'openai-compatible'],
  ['aider', 'openai-compatible'],
  ['pi', 'anthropic@named'],
  ['crush', 'anthropic@named'],
  ['kilo', 'anthropic@named'],
  ['opencode', 'anthropic@named'],
];

const VENDOR: Array<[agent: string, kind: string]> = [
  ...['openai', 'anthropic', 'google', 'openrouter'].flatMap((kind) => ['crush', 'pi', 'trae', 'kilo'].map((agent): [string, string] => [agent, kind])),
  ['opencode', 'google'],
];

describe.runIf(enabled)('providers a harness uses directly (real CLIs)', () => {
  for (const [agentId, route] of LOCAL) {
    it.runIf(installed(agentId))(`${agentId} with ${route}: finishes the task on the endpoint it was given`, async () => {
      const r = await runThroughGateway(agentId, { direct: route });
      if ('skipped' in r) return;
      expect(r.requests.length, r.stderr.slice(-800) + r.stdout.slice(-800)).toBeGreaterThanOrEqual(1);
      expect(r.created?.trim()).toBe(CONTENT);
      expect(interpret(agentId, r).exit.state).toBe('COMPLETED');
    }, 300_000);
  }

  for (const [agentId, kind] of VENDOR) {
    it.runIf(installed(agentId))(`${agentId} with ${kind}: the vendor rejects the key, reported as AUTH_REQUIRED`, async () => {
      const r = await runThroughGateway(agentId, { direct: `${kind}@real` });
      if ('skipped' in r) return;
      const { exit } = interpret(agentId, r);
      expect(exit.state, JSON.stringify(exit) + r.stderr.slice(-600)).toBe('AUTH_REQUIRED');
      // The request went to the vendor, not to the local model.
      expect(r.requests).toHaveLength(0);
    }, 300_000);
  }
});
