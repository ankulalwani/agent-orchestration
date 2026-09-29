/**
 * OpenAI Responses API (what Codex speaks: `wire_api = "responses"`) ↔ OpenAI chat completions.
 * Codex's free-form tools (`type: "custom"`, e.g. apply_patch) become functions with one string
 * argument, `input`, and are answered as custom tool calls again. Reasoning items are not sent upstream.
 */
import type { ChatContentPart, ChatDelta, ChatMessage, ChatRequest, ChatToolCall } from './upstream.js';
import { collect, newCallId } from './upstream.js';
import type { SseWriter } from './sse.js';
import { safeJson } from './anthropic.js';

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === 'string' ? p : (p.text ?? p.output ?? ''))).join('');
  return c === undefined || c === null ? '' : JSON.stringify(c);
}

export interface ResponsesContext {
  /** Tools that are Codex custom tools (free-form input). */
  customTools: Set<string>;
}

export function responsesToChat(body: any): { req: ChatRequest; ctx: ResponsesContext } {
  const messages: ChatMessage[] = [];
  const customTools = new Set<string>();
  if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) });
  const input = typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: body.input }] : (body.input ?? []);
  let pendingCalls: ChatToolCall[] | null = null;
  const flushCalls = () => {
    if (pendingCalls) messages.push({ role: 'assistant', content: null, tool_calls: pendingCalls });
    pendingCalls = null;
  };
  for (const item of input) {
    const type = item.type ?? 'message';
    if (type === 'function_call' || type === 'custom_tool_call' || type === 'local_shell_call') {
      const args = type === 'function_call' ? String(item.arguments ?? '{}') : type === 'custom_tool_call' ? JSON.stringify({ input: item.input ?? '' }) : JSON.stringify(item.action ?? {});
      (pendingCalls ??= []).push({ id: item.call_id ?? item.id ?? newCallId(), type: 'function', function: { name: item.name ?? 'local_shell', arguments: args } });
      continue;
    }
    flushCalls();
    if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'local_shell_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id ?? '', content: contentText(item.output) || '(no output)' });
    } else if (type === 'message') {
      const role = item.role === 'developer' || item.role === 'system' ? 'system' : item.role === 'assistant' ? 'assistant' : 'user';
      if (role === 'assistant') messages.push({ role: 'assistant', content: contentText(item.content) });
      else if (typeof item.content === 'string') messages.push({ role, content: item.content });
      else {
        const parts: ChatContentPart[] = [];
        for (const p of item.content ?? []) {
          if (['input_text', 'output_text', 'text'].includes(p.type)) parts.push({ type: 'text', text: p.text ?? '' });
          else if (p.type === 'input_image' && (p.image_url || p.url)) parts.push({ type: 'image_url', image_url: { url: p.image_url ?? p.url } });
        }
        messages.push({ role, content: parts.every((p) => p.type === 'text') ? parts.map((p) => (p as { text: string }).text).join('\n') : parts });
      }
    }
    // reasoning and other item types are not sent upstream
  }
  flushCalls();
  const tools = (body.tools ?? []).flatMap((t: any) => {
    if (t.type === 'function') return [{ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: 'object', properties: {} } } }];
    if (t.type === 'custom') {
      customTools.add(t.name);
      const grammar = t.format?.definition ? `\n\nThe input must follow this ${t.format.syntax ?? ''} grammar:\n${String(t.format.definition).slice(0, 4000)}` : '';
      return [{ type: 'function' as const, function: { name: t.name, description: `${t.description ?? ''}${grammar}`, parameters: { type: 'object', properties: { input: { type: 'string', description: 'The raw input for the tool' } }, required: ['input'] } } }];
    }
    if (t.type === 'local_shell') return [{ type: 'function' as const, function: { name: 'local_shell', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } }, required: ['command'] } } }];
    return []; // web search, file search, … are not available through add-on models
  });
  const choice = body.tool_choice;
  const tool_choice = !choice || choice === 'auto' ? undefined : choice === 'required' || choice === 'none' ? choice : choice.name ? { type: 'function', function: { name: choice.name } } : undefined;
  return {
    req: {
      messages,
      ...(tools.length ? { tools, ...(tool_choice ? { tool_choice } : {}) } : {}),
      ...(body.max_output_tokens ? { max_tokens: body.max_output_tokens } : {}),
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
      ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
    },
    ctx: { customTools },
  };
}

function toolItem(ctx: ResponsesContext, id: string, callId: string, name: string, args: string, status: 'in_progress' | 'completed') {
  if (ctx.customTools.has(name)) {
    const input = status === 'completed' ? String((safeJson(args) as { input?: unknown }).input ?? args) : '';
    return { type: 'custom_tool_call', id, call_id: callId, name, input, status };
  }
  return { type: 'function_call', id, call_id: callId, name, arguments: args, status };
}

/** Streams the answer as Responses API events (what Codex reads). */
export async function streamResponses(deltas: AsyncGenerator<ChatDelta>, out: SseWriter, model: string, ctx: ResponsesContext) {
  const responseId = newCallId('resp');
  let seq = 0;
  const base = { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), model, status: 'in_progress', output: [] as unknown[] };
  const emit = (type: string, data: Record<string, unknown>) => out.event(type, { type, sequence_number: seq++, ...data });
  emit('response.created', { response: base });
  emit('response.in_progress', { response: base });
  const output: unknown[] = [];
  let outputIndex = -1;
  let text: { id: string; text: string } | null = null;
  let tool: { upstream: number; id: string; callId: string; name: string; args: string } | null = null;
  const usage = { input: 0, output: 0 };
  const closeText = () => {
    if (!text) return;
    const part = { type: 'output_text', text: text.text, annotations: [] };
    emit('response.output_text.done', { item_id: text.id, output_index: outputIndex, content_index: 0, text: text.text });
    emit('response.content_part.done', { item_id: text.id, output_index: outputIndex, content_index: 0, part });
    const item = { type: 'message', id: text.id, status: 'completed', role: 'assistant', content: [part] };
    emit('response.output_item.done', { output_index: outputIndex, item });
    output.push(item);
    text = null;
  };
  const closeTool = () => {
    if (!tool) return;
    emit('response.function_call_arguments.done', { item_id: tool.id, output_index: outputIndex, arguments: tool.args });
    const item = toolItem(ctx, tool.id, tool.callId, tool.name, tool.args, 'completed');
    emit('response.output_item.done', { output_index: outputIndex, item });
    output.push(item);
    tool = null;
  };
  for await (const d of deltas) {
    if (d.kind === 'text') {
      closeTool();
      if (!text) {
        text = { id: newCallId('msg'), text: '' };
        outputIndex++;
        emit('response.output_item.added', { output_index: outputIndex, item: { type: 'message', id: text.id, status: 'in_progress', role: 'assistant', content: [] } });
        emit('response.content_part.added', { item_id: text.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      }
      text.text += d.text;
      emit('response.output_text.delta', { item_id: text.id, output_index: outputIndex, content_index: 0, delta: d.text });
    } else if (d.kind === 'tool') {
      if (!tool || tool.upstream !== d.index) {
        closeText();
        closeTool();
        tool = { upstream: d.index, id: newCallId('fc'), callId: d.id ?? newCallId(), name: d.name ?? 'tool', args: '' };
        outputIndex++;
        emit('response.output_item.added', { output_index: outputIndex, item: toolItem(ctx, tool.id, tool.callId, tool.name, '', 'in_progress') });
      }
      if (d.arguments) {
        tool.args += d.arguments;
        emit('response.function_call_arguments.delta', { item_id: tool.id, output_index: outputIndex, delta: d.arguments });
      }
    } else if (d.kind === 'usage') {
      usage.input = d.input;
      usage.output = d.output;
    }
  }
  closeText();
  closeTool();
  emit('response.completed', { response: { ...base, status: 'completed', output, usage: responsesUsage(usage) } });
}

function responsesUsage(u: { input: number; output: number }) {
  return { input_tokens: u.input, input_tokens_details: { cached_tokens: 0 }, output_tokens: u.output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: u.input + u.output };
}

/** The whole answer as one Responses API object. */
export async function responsesObject(deltas: AsyncGenerator<ChatDelta>, model: string, ctx: ResponsesContext) {
  const r = await collect(deltas);
  const output = [
    ...(r.text ? [{ type: 'message', id: newCallId('msg'), status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: r.text, annotations: [] }] }] : []),
    ...r.tools.map((t) => toolItem(ctx, newCallId('fc'), t.id, t.name, t.arguments, 'completed')),
  ];
  return { id: newCallId('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000), model, status: 'completed', output, output_text: r.text, usage: responsesUsage(r.usage) };
}

export function openaiError(status: number, message: string) {
  const code = status === 429 ? 'rate_limit_exceeded' : status === 401 ? 'invalid_api_key' : 'upstream_error';
  return { error: { message, type: status === 429 ? 'rate_limit_exceeded' : 'api_error', code } };
}
