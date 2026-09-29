/**
 * Gemini API (what Gemini CLI speaks, in its "gateway" mode: GOOGLE_GEMINI_BASE_URL) ↔ OpenAI chat
 * completions. Gemini has no ids for function calls in older requests: calls get ids here, and responses
 * are matched to the oldest open call of the same name. Gemini's OpenAPI-style schemas (types in upper
 * case) are converted to JSON Schema.
 */
import type { ChatContentPart, ChatDelta, ChatMessage, ChatRequest, ChatToolCall } from './upstream.js';
import { collect, newCallId } from './upstream.js';
import type { SseWriter } from './sse.js';
import { safeJson } from './anthropic.js';

function jsonSchema(s: any): any {
  if (Array.isArray(s)) return s.map(jsonSchema);
  if (!s || typeof s !== 'object') return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type' && typeof v === 'string') out.type = v.toLowerCase();
    else if (k === 'nullable' || k === 'propertyOrdering') continue;
    else out[k] = jsonSchema(v);
  }
  return out;
}

function partsText(parts: any[] | undefined) {
  return (parts ?? []).filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
}

export function geminiToChat(body: any): ChatRequest {
  const messages: ChatMessage[] = [];
  const sys = typeof body.systemInstruction === 'string' ? body.systemInstruction : partsText(body.systemInstruction?.parts);
  if (sys) messages.push({ role: 'system', content: sys });
  const open = new Map<string, string[]>(); // function name → ids of calls not answered yet
  for (const c of body.contents ?? []) {
    const parts: any[] = c.parts ?? [];
    if (c.role === 'model') {
      const calls: ChatToolCall[] = parts
        .filter((p) => p.functionCall)
        .map((p) => {
          const id = p.functionCall.id ?? newCallId();
          open.set(p.functionCall.name, [...(open.get(p.functionCall.name) ?? []), id]);
          return { id, type: 'function' as const, function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } };
        });
      messages.push({ role: 'assistant', content: partsText(parts) || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const p of parts) {
      if (!p.functionResponse) continue;
      const name = p.functionResponse.name;
      const queue = open.get(name) ?? [];
      const id = p.functionResponse.id ?? queue.shift() ?? newCallId();
      if (p.functionResponse.id) open.set(name, queue.filter((x) => x !== id));
      messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(p.functionResponse.response ?? {}) });
    }
    const content: ChatContentPart[] = [];
    for (const p of parts) {
      if (typeof p.text === 'string' && !p.thought && p.text) content.push({ type: 'text', text: p.text });
      else if (p.inlineData?.data) content.push({ type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType ?? 'image/png'};base64,${p.inlineData.data}` } });
    }
    if (content.length) messages.push({ role: 'user', content: content.every((x) => x.type === 'text') ? content.map((x) => (x as { text: string }).text).join('\n') : content });
  }
  const tools = (body.tools ?? []).flatMap((t: any) =>
    (t.functionDeclarations ?? []).map((f: any) => ({ type: 'function' as const, function: { name: f.name, description: f.description, parameters: f.parametersJsonSchema ?? jsonSchema(f.parameters) ?? { type: 'object', properties: {} } } })),
  );
  const g = body.generationConfig ?? {};
  const mode = body.toolConfig?.functionCallingConfig?.mode;
  return {
    messages,
    ...(tools.length ? { tools, ...(mode === 'ANY' ? { tool_choice: 'required' } : mode === 'NONE' ? { tool_choice: 'none' } : {}) } : {}),
    ...(g.maxOutputTokens ? { max_tokens: g.maxOutputTokens } : {}),
    ...(typeof g.temperature === 'number' ? { temperature: g.temperature } : {}),
    ...(typeof g.topP === 'number' ? { top_p: g.topP } : {}),
    ...(g.stopSequences?.length ? { stop: g.stopSequences } : {}),
    // Structured output (Gemini CLI uses it for small checks): ask for JSON.
    ...(g.responseMimeType === 'application/json' ? { response_format: { type: 'json_object' } } : {}),
  };
}

const FINISH: Record<string, string> = { stop: 'STOP', length: 'MAX_TOKENS', tool_calls: 'STOP', content_filter: 'SAFETY' };

function usageMetadata(u: { input: number; output: number }) {
  return { promptTokenCount: u.input, candidatesTokenCount: u.output, totalTokenCount: u.input + u.output };
}

/** Streams the answer as Gemini `streamGenerateContent?alt=sse` chunks. Function calls are sent once complete. */
export async function streamGemini(deltas: AsyncGenerator<ChatDelta>, out: SseWriter, model: string) {
  const tools: Array<{ id: string; name: string; arguments: string }> = [];
  let finish = 'stop';
  const usage = { input: 0, output: 0 };
  for await (const d of deltas) {
    if (d.kind === 'text') out.data({ candidates: [{ content: { role: 'model', parts: [{ text: d.text }] }, index: 0 }], modelVersion: model });
    else if (d.kind === 'tool') {
      const t = (tools[d.index] ??= { id: d.id ?? newCallId(), name: '', arguments: '' });
      if (d.id) t.id = d.id;
      if (d.name && !t.name) t.name = d.name;
      if (d.arguments) t.arguments += d.arguments;
    } else if (d.kind === 'finish') finish = d.reason;
    else {
      usage.input = d.input;
      usage.output = d.output;
    }
  }
  const calls = tools.filter(Boolean).map((t) => ({ functionCall: { id: t.id, name: t.name, args: safeJson(t.arguments) } }));
  out.data({
    candidates: [{ content: { role: 'model', parts: calls.length ? calls : [{ text: '' }] }, finishReason: FINISH[finish] ?? 'STOP', index: 0 }],
    usageMetadata: usageMetadata(usage),
    modelVersion: model,
  });
}

/** The whole answer as one `generateContent` response. */
export async function geminiResponse(deltas: AsyncGenerator<ChatDelta>, model: string) {
  const r = await collect(deltas);
  const parts = [...(r.text ? [{ text: r.text }] : []), ...r.tools.map((t) => ({ functionCall: { id: t.id, name: t.name, args: safeJson(t.arguments) } }))];
  return { candidates: [{ content: { role: 'model', parts: parts.length ? parts : [{ text: '' }] }, finishReason: FINISH[r.finish] ?? 'STOP', index: 0 }], usageMetadata: usageMetadata(r.usage), modelVersion: model };
}

export function geminiError(status: number, message: string) {
  return { error: { code: status, message, status: status === 429 ? 'RESOURCE_EXHAUSTED' : status === 401 ? 'UNAUTHENTICATED' : 'UNAVAILABLE' } };
}
