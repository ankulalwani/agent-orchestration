/**
 * Every harness through the worker's model gateway, for real: the installed CLI speaks its own API
 * (Anthropic Messages, OpenAI Responses, Gemini, OpenAI chat) to the gateway, which serves it from a fake
 * OpenAI-compatible model. The model asks for hello.txt with the harness's own file tool; the harness
 * runs the tool and gets the result back to the model. No real model is used, so nothing is billed.
 * Runs with AO_TEST_AGENT_CLIS=1; harnesses that aren't installed are skipped.
 */
import { describe, expect, it } from 'vitest';
import { ADAPTERS, CONTENT, findExecutable, runThroughGateway } from './gateway-harness.js';

const enabled = process.env.AO_TEST_AGENT_CLIS === '1';

describe.runIf(enabled)('harnesses through the model gateway (real CLIs, fake model)', () => {
  for (const agentId of Object.keys(ADAPTERS)) {
    const installed = Boolean(findExecutable(ADAPTERS[agentId]!));
    it.runIf(installed)(`${agentId}: its own file tool creates the file, and the tool result goes back to the model`, async () => {
      const r = await runThroughGateway(agentId);
      if ('skipped' in r) return;
      expect(r.exitCode, r.stderr.slice(-1500)).toBe(0);
      expect(r.requests.length).toBeGreaterThanOrEqual(agentId === 'aider' ? 1 : 2);
      expect(r.requests.every((q) => q.model === 'fake-model')).toBe(true);
      if (agentId === 'aider') {
        // Aider edits through its text edit format (no tools).
        expect(r.created?.trim()).toBe(CONTENT);
        return;
      }
      // The harness returned its tool's result to the model through the gateway.
      expect(r.requests.at(-1)!.messages.some((m: any) => m.role === 'tool')).toBe(true);
      // Codex's own sandbox refuses commands in this setup on Windows ("blocked by policy"), which is
      // Codex's policy, not the gateway's: its round trip is checked above.
      if (agentId !== 'codex' || process.platform !== 'win32') expect(r.created?.trim()).toBe(CONTENT);
    }, 300_000);
  }
});
