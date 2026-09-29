import { zodToJsonSchema } from 'zod-to-json-schema';
import { API_PREFIX } from '@ao/contracts';
import type { RouteSpec } from './http.js';

/** OpenAPI 3.1 document generated from the same Zod contracts used for validation (spec §71). */
export function buildOpenApi(specs: RouteSpec[], serverUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  const toJson = (s: unknown) => zodToJsonSchema(s as never, { target: 'openApi3', $refStrategy: 'none' });
  for (const r of specs) {
    const p = (API_PREFIX + r.path).replace(/:(\w+)/g, '{$1}');
    const params = [...r.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const op: Record<string, unknown> = {
      summary: r.summary,
      tags: [r.tag],
      parameters: params,
      security: r.auth === 'none' ? [] : [{ [r.auth === 'worker' ? 'workerCredential' : 'bearer']: [] }],
      responses: {
        '200': { description: 'OK', ...(r.response ? { content: { 'application/json': { schema: toJson(r.response) } } } : {}) },
        default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
    if (r.permission) op['x-permission'] = r.permission;
    if (r.body) op.requestBody = { required: true, content: { 'application/json': { schema: toJson(r.body) } } };
    if (r.query) {
      const q = toJson(r.query) as { properties?: Record<string, unknown> };
      for (const [name, schema] of Object.entries(q.properties ?? {})) (op.parameters as unknown[]).push({ name, in: 'query', schema });
    }
    paths[p] = { ...(paths[p] ?? {}), [r.method.toString().toLowerCase()]: op };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Agent Orchestration API', version: '1.0.0' },
    servers: [{ url: serverUrl }],
    paths,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        workerCredential: { type: 'http', scheme: 'bearer', description: 'Worker credential (aow_…) issued at pairing' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: { code: { type: 'string' }, message: { type: 'string' }, correlationId: { type: 'string' }, retryable: { type: 'boolean' }, context: { type: 'object' } },
              required: ['code', 'message'],
            },
          },
        },
      },
    },
  };
}
