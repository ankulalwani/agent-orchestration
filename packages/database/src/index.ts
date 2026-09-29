import mongoose from 'mongoose';
import { AppError } from '@ao/core';
import { ALL_MODELS } from './models.js';

export * from './models.js';
export * from './migrations.js';
import { runMigrations } from './migrations.js';
export { mongoose };

export interface ConnectOptions {
  uri: string;
  dbName?: string;
  /** Build indexes on startup (default true). Production may prefer the `db:indexes` script. */
  syncIndexes?: boolean;
  /** Apply pending data migrations on startup (default true). */
  migrate?: boolean;
}

/** Connect with retry-friendly driver settings (spec §86). */
export async function connectDatabase(opts: ConnectOptions) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(opts.uri, {
    dbName: opts.dbName,
    serverSelectionTimeoutMS: 10_000,
    retryWrites: true,
    retryReads: true,
    maxPoolSize: 50,
  });
  // Migrations first, so one can drop or reshape an index before ensureIndexes (re)creates indexes.
  if (opts.migrate !== false) await runMigrations();
  if (opts.syncIndexes !== false) await ensureIndexes();
  return mongoose.connection;
}

export async function ensureIndexes() {
  await Promise.all(ALL_MODELS.map((m) => (m as mongoose.Model<unknown>).createIndexes()));
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}

/**
 * Readiness: a real round trip, bounded by `timeoutMs`. The connection state alone can still say
 * "connected" for a while after the server has gone away.
 */
export async function databaseHealthy(timeoutMs = 2000): Promise<boolean> {
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== 1 || !db) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      db.admin().command({ ping: 1 }).then((r) => r.ok === 1),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs))),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse an id from a client. Invalid ids are "not found", never a 500. */
export function oid(id: string | mongoose.Types.ObjectId, what = 'Resource'): mongoose.Types.ObjectId {
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (!mongoose.isValidObjectId(id) || !/^[a-f0-9]{24}$/i.test(id)) throw new AppError('NOT_FOUND', `${what} not found`);
  return new mongoose.Types.ObjectId(id);
}

export const isValidOid = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);

/** Tenant scope helper (spec §18): every org-owned query must include this filter. */
export function orgScope(organizationId: string | mongoose.Types.ObjectId) {
  return { organizationId: oid(organizationId, 'Organization') };
}

export function isDuplicateKeyError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: number }).code === 11000;
}
