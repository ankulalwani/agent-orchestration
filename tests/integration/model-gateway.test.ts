/**
 * The worker's model gateway: each harness API (Anthropic Messages, OpenAI Responses, Gemini, OpenAI
 * chat) is translated to OpenAI-compatible chat completions, streamed back in the harness's format with
 * text and tool calls, and falls back along the add-on models on limits and outages.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModelGateway, type GatewaySession } from '../../apps/worker/src/gateway/server.js';
import type { GatewayTarget } from '../../apps/worker/src/gateway/upstream.js';
import { FakeLlm } from '../fake-llm.js';

let a: FakeLlm;
let b: FakeLlm;
let gateway: ModelGateway;
let session: GatewaySession;
const limits: Array<{ providerId: string; retryAt: number | null }> = [];
const served: string[] = [];
const limited = new Set<string>();

const target = (id: string, llm: FakeLlm, model: string): GatewayTarget => ({ providerId: id, name: id, baseUrl: llm.url, apiKey: `key-${id}`, model, kind: 'openai-compatible' });

beforeAll(async () => {
  a = await new FakeLlm().start();
  b = await new FakeLlm().start();
  gateway = new ModelGateway({ isLimited: (id) => limited.has(id), onLimit: (t, retryAt) => void limits.push({ providerId: t.providerId, retryAt }) });
  session = await gateway.open({ chain: [target('first', a, 'model-a'), target('second', b, 'model-b')], alias: 'ao-addon', onServed: (t) => void served.push(t.providerId) });
});
afterAll(async () => {
  await gateway.stop();
  a.close();
  b.close();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${session.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}`, ...headers }, body: JSON.stringify(body) });
/** Named server-sent events of a response. */
async function events(res: Response) {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const ev = /^event: (.+)$/m.exec(block)?.[1] ?? null;
      const data = /^data: (.+)$/m.exec(block)?.[1] ?? '';
      return { event: ev, data: data === '[DONE]' ? data : JSON.parse(data) };
    });
}

describe('model gateway', () => {
  it('refuses requests without the session token', async () => {
    const r = await fetch(`${session.baseUrl}/anthropic/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'wrong' }, body: '{}' });
    expect(r.status).toBe(401);
  });

  it('Anthropic Messages (Claude Code): tools, tool results and system go upstream; text and tool use stream back', async () => {
    a.handler = () => ({ text: 'Let me write it.', toolCalls: [{ name: 'Write', arguments: { file_path: 'a.txt', content: 'hi' } }] });
    const res = await post('/anthropic/v1/messages', {
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      stream: true,
      system: [{ type: 'text', text: 'You are helpful' }],
      tools: [{ name: 'Write', description: 'Write a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }, { type: 'web_search_20250305', name: 'web_search' }],
      messages: [
        { role: 'user', content: 'write a.txt' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'x' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'b' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'contents of b' }] }, { type: 'text', text: 'go on' }] },
      ],
    }, { 'x-api-key': session.token });
    expect(res.status).toBe(200);
    const up = a.requests.at(-1)!;
    expect(up.model).toBe('model-a');
    expect(up.headers.authorization).toBe('Bearer key-first');
    expect(up.messages).toEqual([
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'write a.txt' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"b"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'contents of b' },
      { role: 'user', content: 'go on' },
    ]);
    expect(up.tools?.map((t) => t.function.name)).toEqual(['Write']); // the server tool is left out
    const evs = await events(res);
    // message_start, a text block, a tool_use block, message_delta, message_stop (deltas collapsed).
    const shape = evs.map((e) => e.event).filter((e, i, all) => !(e === 'content_block_delta' && all[i - 1] === 'content_block_delta'));
    expect(shape).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    const text = evs.filter((e) => e.data.delta?.type === 'text_delta').map((e) => e.data.delta.text).join('');
    const json = evs.filter((e) => e.data.delta?.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('');
    expect(text).toBe('Let me write it.');
    expect(evs.filter((e) => e.event === 'content_block_start')[1]!.data.content_block).toMatchObject({ type: 'tool_use', name: 'Write', id: expect.stringMatching(/^call_fake_/) });
    expect(JSON.parse(json)).toEqual({ file_path: 'a.txt', content: 'hi' });
    expect(evs.find((e) => e.event === 'message_delta')!.data.delta.stop_reason).toBe('tool_use');
  });

  it('falls back to the next add-on model on a limit, and reports the limit', async () => {
    a.handler = () => ({ status: 429, retryAfter: 60 });
    b.handler = () => ({ text: 'from b' });
    const res = await post('/anthropic/v1/messages', { model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect(await res.json()).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'from b' }], stop_reason: 'end_turn' });
    expect(limits.at(-1)).toMatchObject({ providerId: 'first', retryAt: expect.any(Number) });
    expect(served.at(-1)).toBe('second');
    // A model known to be limited is skipped without asking it again.
    limited.add('first');
    const before = a.requests.length;
    await (await post('/anthropic/v1/messages', { model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })).json();
    expect(a.requests.length).toBe(before);
    limited.clear();
  });

  it('answers with a limit error in the harness format when every add-on model is limited', async () => {
    a.handler = () => ({ status: 429, retryAfter: 30 });
    b.handler = () => ({ status: 429 });
    const anth = await post('/anthropic/v1/messages', { model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect(anth.status).toBe(429);
    expect(anth.headers.get('retry-after')).toBe('30');
    expect(await anth.json()).toMatchObject({ type: 'error', error: { type: 'rate_limit_error', message: expect.stringContaining('All add-on models are at their limit') } });
    const gem = await post(`/gemini/v1beta/models/x:generateContent`, { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, { 'x-goog-api-key': session.token });
    expect(await gem.json()).toMatchObject({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } });
    // An outage (5xx) of the first falls through to the second.
    a.handler = () => ({ status: 503 });
    b.handler = () => ({ text: 'b again' });
    expect((await (await post('/openai/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] })).json()).choices[0].message.content).toBe('b again');
  });

  it('OpenAI Responses (Codex): function and custom tools, their outputs, and the Responses event stream', async () => {
    a.handler = () => ({ toolCalls: [{ name: 'apply_patch', arguments: { input: '*** Begin Patch\n*** End Patch' } }, { name: 'shell', arguments: { command: ['ls'] } }] });
    const res = await post('/openai/v1/responses', {
      model: 'gpt-5-codex',
      instructions: 'Be a coder',
      stream: true,
      tools: [
        { type: 'function', name: 'shell', description: 'Run', parameters: { type: 'object', properties: { command: { type: 'array' } } } },
        { type: 'custom', name: 'apply_patch', description: 'Patch files', format: { type: 'grammar', syntax: 'lark', definition: 'start: "x"' } },
        { type: 'web_search' },
      ],
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }] },
        { type: 'reasoning', summary: [] },
        { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"command":["cat","a"]}' },
        { type: 'function_call_output', call_id: 'c1', output: 'file a' },
        { type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: 'PATCH' },
        { type: 'custom_tool_call_output', call_id: 'c2', output: 'Done' },
      ],
    });
    const up = a.requests.at(-1)!;
    expect(up.messages).toEqual([
      { role: 'system', content: 'Be a coder' },
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"command":["cat","a"]}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'file a' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"PATCH"}' } }] },
      { role: 'tool', tool_call_id: 'c2', content: 'Done' },
    ]);
    expect(up.tools?.map((t) => t.function.name)).toEqual(['shell', 'apply_patch']);
    expect(up.tools?.[1].function.description).toContain('lark grammar');
    const evs = await events(res);
    expect(evs[0]!.event).toBe('response.created');
    const done = evs.filter((e) => e.event === 'response.output_item.done').map((e) => e.data.item);
    expect(done).toEqual([
      expect.objectContaining({ type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch', status: 'completed' }),
      expect.objectContaining({ type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', status: 'completed' }),
    ]);
    const completed = evs.at(-1)!;
    expect(completed.event).toBe('response.completed');
    expect(completed.data.response).toMatchObject({ status: 'completed', output: done, usage: { total_tokens: expect.any(Number) } });
    expect(evs.map((e) => e.data.sequence_number)).toEqual(evs.map((_, i) => i));
  });

  it('Gemini (Gemini CLI): function calls get ids, responses match them, schemas become JSON Schema', async () => {
    a.handler = () => ({ text: 'Writing.', toolCalls: [{ name: 'write_file', arguments: { file_path: 'x', content: 'y' } }] });
    const res = await post(`/gemini/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse`, {
      systemInstruction: { parts: [{ text: 'sys' }] },
      tools: [{ functionDeclarations: [{ name: 'read_file', description: 'Read', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] } }, { name: 'write_file', parametersJsonSchema: { type: 'object', properties: {} } }] }],
      contents: [
        { role: 'user', parts: [{ text: 'do it' }] },
        { role: 'model', parts: [{ text: 'reading', thought: true }, { functionCall: { name: 'read_file', args: { path: 'a' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'A' } } }] },
      ],
      generationConfig: { temperature: 0.2, maxOutputTokens: 500 },
    }, { authorization: '', 'x-goog-api-key': session.token });
    const up = a.requests.at(-1)!;
    const callId = up.messages[2].tool_calls[0].id;
    expect(up.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: callId, content: '{"output":"A"}' },
    ]);
    expect(up.tools?.[0].function.parameters).toEqual({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] });
    expect(up.body).toMatchObject({ temperature: 0.2, max_tokens: 500 });
    const chunks = (await events(res)).map((e) => e.data);
    expect(chunks.map((c) => c.candidates[0].content.parts[0].text ?? '').join('')).toBe('Writing.');
    expect(chunks.at(-1)).toMatchObject({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'write_file', args: { file_path: 'x', content: 'y' } } }] }, finishReason: 'STOP' }], usageMetadata: expect.any(Object) });
  });

  it('OpenAI chat (OpenCode, Aider): streams chunks under the harness model name; non-streamed answers too', async () => {
    a.handler = () => ({ text: 'hello there', toolCalls: [{ name: 'bash', arguments: { cmd: 'ls' } }] });
    const res = await post('/openai/v1/chat/completions', { model: 'ao-addon', stream: true, messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'bash', parameters: {} } }] });
    const evs = await events(res);
    expect(evs.at(-1)!.data).toBe('[DONE]');
    const chunks = evs.slice(0, -1).map((e) => e.data);
    expect(chunks.every((c) => c.model === 'ao-addon')).toBe(true);
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('hello there');
    const args = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []).map((t: any) => t.function.arguments).join('');
    expect(JSON.parse(args)).toEqual({ cmd: 'ls' });
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe('tool_calls');
    const models = await (await fetch(`${session.baseUrl}/openai/v1/models`, { headers: { authorization: `Bearer ${session.token}` } })).json();
    expect(models.data[0].id).toBe('ao-addon');
  });

  it('closes sessions: their token stops working', async () => {
    const s2 = await gateway.open({ chain: [target('first', a, 'm')] });
    s2.close();
    const r = await fetch(`${s2.baseUrl}/openai/v1/models`, { headers: { authorization: `Bearer ${s2.token}` } });
    expect(r.status).toBe(401);
  });
});
