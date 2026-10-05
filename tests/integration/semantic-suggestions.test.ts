/**
 * Semantic marketplace suggestions: with an embeddings API configured, packages close in meaning to a
 * description are suggested even when they share no words with it. A fake API stands in for the model:
 * it maps words of the same meaning to the same direction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearDatabase, startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { CapabilityPackage } from '@ao/database';
import { EmbeddingService, RegistryService, cosine, type Actor, type Services } from '@ao/server';
import { makeOwner, makeServices } from '../helpers.js';

let s: Services;
let publisher: Actor;
const admin = (a: Actor) => ({ userId: a.userId, correlationId: 't', platformAdmin: true });

/** Concepts and the made-up words that mean them (words the built-in rules know nothing about). */
const CONCEPTS = [['glorp', 'zimzam', 'frobnicate'], ['wibble', 'quux', 'snarf'], ['blarg', 'plugh']];
const vectorOf = (text: string) => {
  const t = text.toLowerCase();
  return CONCEPTS.map((words) => words.reduce((n, w) => n + (t.split(w).length - 1), 0));
};
const calls: Array<{ url: string; auth: string | null; inputs: string[] }> = [];
let failing = false;
const fakeEmbeddings = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
  const body = JSON.parse(init.body) as { model: string; input: string[] };
  calls.push({ url, auth: init.headers.authorization ?? null, inputs: body.input });
  if (failing) return new Response('{"error":"overloaded"}', { status: 503 });
  // Out of order on purpose: the client must go by `index`.
  return new Response(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vectorOf(text) })).reverse() }), { status: 200 });
}) as unknown as typeof fetch;
const semantic = () => new RegistryService({ REGISTRY_SEARCH: 'text', EMBEDDINGS_URL: 'http://embeddings.test/v1/', EMBEDDINGS_API_KEY: 'emb-key', EMBEDDINGS_MODEL: 'fake-1', EMBEDDINGS_MIN_SIMILARITY: 0.5 }, fakeEmbeddings);

const manifest = (id: string, description: string) => ({ id, name: id, version: '1.0.0', type: 'skill', description, skill: { instructions: `Follow ${id}.` } });

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
  await clearDatabase();
  publisher = (await makeOwner(s, 'vendor')).actor;
  for (const [id, description, publish] of [
    ['alpha-helper', 'Helps you frobnicate a glorp safely, with checks before and after every step.', true],
    ['beta-helper', 'Everything about wibble handling: naming, layout and review rules for teams.', true],
    ['gamma-helper', 'House rules for writing React components and their tests in a project.', true],
    ['hidden-helper', 'A private way to frobnicate a glorp that only its owner should ever see.', false],
  ] as const) {
    const r = await s.capabilities.register(publisher, manifest(id, description));
    if (publish) {
      await s.registry.requestPublish(publisher, r.capabilityId, true);
      await s.registry.review(admin(publisher), r.capabilityId, { decision: 'approve', notes: '' });
    }
  }
});
afterAll(stopTestDatabase);

const suggest = (r: RegistryService, text: string) => r.suggest(null, { text, limit: 10 });
const names = (x: Awaited<ReturnType<typeof suggest>>) => x.items.map((i) => i.package.name);

describe('embeddings client', () => {
  it('is off without a URL, and sends batches with the key when on', async () => {
    const off = new EmbeddingService({});
    expect(off.enabled).toBe(false);
    await expect(off.embed(['x'])).rejects.toThrow(/not configured/);
    calls.length = 0;
    const on = new EmbeddingService({ EMBEDDINGS_URL: 'http://embeddings.test/v1', EMBEDDINGS_API_KEY: 'k', EMBEDDINGS_MODEL: 'fake-1' }, fakeEmbeddings);
    const vectors = await on.embed(Array.from({ length: 70 }, (_, i) => (i === 69 ? 'glorp glorp' : 'wibble')));
    expect(vectors).toHaveLength(70);
    expect(vectors[69]![0]).toBe(2);
    expect(vectors[0]![1]).toBe(1);
    expect(calls.map((c) => [c.url, c.auth, c.inputs.length])).toEqual([['http://embeddings.test/v1/embeddings', 'Bearer k', 64], ['http://embeddings.test/v1/embeddings', 'Bearer k', 6]]);
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe('semantic suggestions', () => {
  it('without an embeddings API nothing is sent, and words the rules do not know find nothing', async () => {
    calls.length = 0;
    expect(names(await suggest(s.registry, 'I need to zimzam something today'))).toEqual([]);
    expect(await s.registry.embedStale()).toBe(0);
    expect(calls).toEqual([]);
    expect(await CapabilityPackage.countDocuments({ embedding: { $exists: true } })).toBe(0);
  });

  it('embeds the listings once, and suggests what is close in meaning; private packages stay out', async () => {
    const r = semantic();
    calls.length = 0;
    expect(await r.embedStale()).toBe(4);
    expect(await r.embedStale()).toBe(0); // nothing left for this model
    expect(calls[0]!.inputs.some((t) => t.includes('frobnicate a glorp safely'))).toBe(true);

    const found = await suggest(r, 'I need to zimzam something today');
    expect(names(found)).toEqual(['alpha-helper']);
    expect(found.items[0]).toMatchObject({ reasons: ['Close in meaning to what you described'], installed: false });
    expect(found.items[0]!.score).toBeGreaterThanOrEqual(3);
    expect(names(await suggest(r, 'how do we deal with a quux and a snarf'))).toEqual(['beta-helper']);
    // Nothing close enough: nothing suggested.
    expect(names(await suggest(r, 'completely different subject matter here'))).toEqual([]);
    // The embedding never leaves the server.
    expect(JSON.stringify(found)).not.toContain('"embedding"');
  });

  it('adds to the rules instead of replacing them, and survives an API outage', async () => {
    const r = semantic();
    const both = await suggest(r, 'a new React component, and also how to zimzam');
    expect(names(both).sort()).toEqual(['alpha-helper', 'gamma-helper']);
    expect(both.items.find((i) => i.package.name === 'gamma-helper')!.reasons.join(' ')).not.toMatch(/Close in meaning/);

    failing = true;
    try {
      // The rules still answer; the semantic part is simply missing.
      expect(names(await suggest(r, 'a new React component, and also how to zimzam'))).toEqual(['gamma-helper']);
      await CapabilityPackage.updateMany({}, { $unset: { embedding: 1 } });
      await expect(r.embedStale()).rejects.toThrow(/HTTP 503/);
    } finally {
      failing = false;
    }
  });

  it('a changed listing is embedded again; only server administrators start a full run', async () => {
    const r = semantic();
    await r.embedStale();
    const before = await CapabilityPackage.findOne({ name: 'gamma-helper' }).select('+embedding').lean();
    expect((before!.embedding as { model: string }).model).toBe('fake-1');
    await r.updateListing(publisher, before!.ref, { readme: 'Now also explains how to plugh a blarg.' } as never);
    await expect.poll(async () => ((await CapabilityPackage.findOne({ name: 'gamma-helper' }).select('+embedding').lean())!.embedding as { vector: number[] } | undefined)?.vector?.[2]).toBe(2);
    expect(names(await suggest(semantic(), 'we have to plugh the blarg'))).toEqual(['gamma-helper']);

    await expect(r.embedAll({ userId: publisher.userId, correlationId: 't', platformAdmin: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(s.registry.embedAll(admin(publisher))).rejects.toThrow(/No embeddings API is configured/);
    expect(await r.embedAll(admin(publisher))).toEqual({ embedded: 0, model: 'fake-1' });
  });
});
