/**
 * Anthropic Messages API (what Claude Code speaks) ↔ OpenAI chat completions. Thinking blocks are not
 * sent upstream (other models don't take Anthropic's signed thinking), and server tools without an input
 * schema (web search, …) are left out.
 */
import type { ChatContentPart, ChatDelta, ChatMessage, ChatRequest } from './upstream.js';
import { collect, newCallId } from './upstream.js';
import type { SseWriter } from './sse.js';

type Block = { type: string; text?: string; source?: { type: string; media_type?: string; data?: string; url?: string }; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b: Block) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[image]' : '')).join('\n');
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

function imagePart(b: Block): ChatContentPart | null {
  if (b.source?.type === 'base64' && b.source.data) return { type: 'image_url', image_url: { url: `data:${b.source.media_type ?? 'image/png'};base64,${b.source.data}` } };
  if (b.source?.type === 'url' && b.source.url) return { type: 'image_url', image_url: { url: b.source.url } };
  return null;
}

export function anthropicToChat(body: any): ChatRequest {
  const messages: ChatMessage[] = [];
  const system = textOf(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const m of body.messages ?? []) {
    if (typeof m.content === 'string') {
      messages.push(m.role === 'assistant' ? { role: 'assistant', content: m.content } : { role: 'user', content: m.content });
      continue;
    }
    const blocks = (m.content ?? []) as Block[];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id ?? newCallId('toolu'), type: 'function' as const, function: { name: b.name ?? 'tool', arguments: JSON.stringify(b.input ?? {}) } }));
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool results must directly follow the assistant's tool calls; the rest of the turn comes after.
    for (const b of blocks) if (b.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: b.tool_use_id ?? '', content: textOf(b.content) || '(no output)' });
    const parts: ChatContentPart[] = [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') {
        const p = imagePart(b);
        if (p) parts.push(p);
      }
    }
    if (parts.length) messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => (p as { text: string }).text).join('\n') : parts });
  }
  const tools = (body.tools ?? [])
    .filter((t: any) => t.input_schema)
    .map((t: any) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const choice = body.tool_choice;
  const tool_choice = !choice ? undefined : choice.type === 'any' ? 'required' : choice.type === 'tool' ? { type: 'function', function: { name: choice.name } } : choice.type === 'none' ? 'none' : 'auto';
  return {
    messages,
    ...(tools.length ? { tools, ...(tool_choice ? { tool_choice } : {}) } : {}),
    ...(body.max_tokens ? { max_tokens: body.max_tokens } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(body.stop_sequences?.length ? { stop: body.stop_sequences } : {}),
  };
}

const STOP: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'refusal' };

/** Streams the answer as Anthropic server-sent events. */
export async function streamAnthropic(deltas: AsyncGenerator<ChatDelta>, out: SseWriter, model: string) {
  const id = newCallId('msg');
  out.event('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  let index = -1;
  let open: { kind: 'text' } | { kind: 'tool'; upstream: number } | null = null;
  let usedTools = false;
  let finish = 'stop';
  const usage = { input: 0, output: 0 };
  const close = () => {
    if (open) out.event('content_block_stop', { type: 'content_block_stop', index });
    open = null;
  };
  for await (const d of deltas) {
    if (d.kind === 'text') {
      if (open?.kind !== 'text') {
        close();
        index++;
        open = { kind: 'text' };
        out.event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      }
      out.event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: d.text } });
    } else if (d.kind === 'tool') {
      if (open?.kind !== 'tool' || open.upstream !== d.index) {
        close();
        index++;
        usedTools = true;
        open = { kind: 'tool', upstream: d.index };
        out.event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: d.id ?? newCallId('toolu'), name: d.name ?? 'tool', input: {} } });
      }
      if (d.arguments) out.event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: d.arguments } });
    } else if (d.kind === 'finish') finish = d.reason;
    else {
      usage.input = d.input;
      usage.output = d.output;
    }
  }
  close();
  const stop = usedTools ? 'tool_use' : (STOP[finish] ?? 'end_turn');
  out.event('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: usage.input, output_tokens: usage.output } });
  out.event('message_stop', { type: 'message_stop' });
}

/** The whole answer as one Anthropic message. */
export async function anthropicMessage(deltas: AsyncGenerator<ChatDelta>, model: string) {
  const r = await collect(deltas);
  const content = [
    ...(r.text ? [{ type: 'text', text: r.text }] : []),
    ...r.tools.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: safeJson(t.arguments) })),
  ];
  return {
    id: newCallId('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: r.tools.length ? 'tool_use' : (STOP[r.finish] ?? 'end_turn'),
    stop_sequence: null,
    usage: { input_tokens: r.usage.input, output_tokens: r.usage.output },
  };
}

export function safeJson(s: string): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return { _raw: s };
  }
}

export function anthropicError(status: number, message: string) {
  const type = status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : status === 400 ? 'invalid_request_error' : status === 529 ? 'overloaded_error' : 'api_error';
  return { type: 'error', error: { type, message } };
}
