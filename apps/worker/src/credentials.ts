import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createLogger } from '@ao/core';

const log = createLogger('credentials');
const SERVICE = 'agent-orchestration-worker';

/**
 * Credential store (spec §13, §59, decision D-006). Prefers the OS store (Windows Credential Manager,
 * macOS Keychain, Linux Secret Service) through @napi-rs/keyring. When unavailable, falls back to an
 * AES-256-GCM encrypted file with a 0600 key file, and reports that in diagnostics. Never plaintext.
 */
export interface CredentialStore {
  readonly backend: 'os-keyring' | 'encrypted-file';
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
}

type KeyringEntry = { getPassword(): string | null | undefined; setPassword(v: string): void; deletePassword(): boolean | void };
export type KeyringModule = { Entry: new (service: string, account: string) => KeyringEntry };

/** Names are tracked in an index file (names only, no values) because keyrings can't enumerate portably. */
class Index {
  constructor(private file: string) {}
  read(): string[] {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return [];
    }
  }
  write(names: string[]) {
    fs.writeFileSync(this.file, JSON.stringify([...new Set(names)].sort()), { mode: 0o600 });
  }
}

class OsKeyringStore implements CredentialStore {
  readonly backend = 'os-keyring' as const;
  constructor(
    private mod: KeyringModule,
    private index: Index,
  ) {}
  async get(name: string) {
    try {
      return new this.mod.Entry(SERVICE, name).getPassword() ?? null;
    } catch {
      return null;
    }
  }
  async set(name: string, value: string) {
    new this.mod.Entry(SERVICE, name).setPassword(value);
    this.index.write([...this.index.read(), name]);
  }
  async delete(name: string) {
    try {
      new this.mod.Entry(SERVICE, name).deletePassword();
    } catch {
      /* already gone */
    }
    this.index.write(this.index.read().filter((n) => n !== name));
  }
  async list() {
    return this.index.read();
  }
}

class EncryptedFileStore implements CredentialStore {
  readonly backend = 'encrypted-file' as const;
  private key: Buffer;
  constructor(private dir: string) {
    const keyFile = path.join(dir, 'credentials.key');
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    this.key = fs.readFileSync(keyFile);
  }
  private file() {
    return path.join(this.dir, 'credentials.enc');
  }
  private readAll(): Record<string, string> {
    if (!fs.existsSync(this.file())) return {};
    const [iv, tag, ct] = fs.readFileSync(this.file(), 'utf8').split('.');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv!, 'base64url'));
    d.setAuthTag(Buffer.from(tag!, 'base64url'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(ct!, 'base64url')), d.final()]).toString('utf8'));
  }
  private writeAll(data: Record<string, string>) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
    fs.writeFileSync(this.file(), [iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.'), { mode: 0o600 });
  }
  async get(name: string) {
    return this.readAll()[name] ?? null;
  }
  async set(name: string, value: string) {
    this.writeAll({ ...this.readAll(), [name]: value });
  }
  async delete(name: string) {
    const all = this.readAll();
    delete all[name];
    this.writeAll(all);
  }
  async list() {
    return Object.keys(this.readAll());
  }
}

/**
 * A worker that ran without the OS store (worker packages up to v0.2.14 carried the keyring binary of the build
 * machine only) kept its credentials in the encrypted file. Once the OS store works, copy them over, one time:
 * otherwise the worker would look unpaired. The file stays where it is, so a rollback to the older version
 * still finds its credentials; the marker stops a credential deleted later from coming back.
 */
async function migrateFromFile(dataDir: string, store: OsKeyringStore) {
  const marker = path.join(dataDir, 'credentials.migrated');
  if (fs.existsSync(marker) || !fs.existsSync(path.join(dataDir, 'credentials.enc'))) return;
  const file = new EncryptedFileStore(dataDir);
  let moved = 0;
  for (const name of await file.list()) {
    const value = await file.get(name);
    if (value !== null && (await store.get(name)) === null) {
      await store.set(name, value);
      moved++;
    }
  }
  fs.writeFileSync(marker, new Date().toISOString() + '\n', { mode: 0o600 });
  if (moved) log.info({ moved }, 'credentials copied from the encrypted file to the OS credential store');
}

export async function createCredentialStore(dataDir: string, opts: { forceFile?: boolean; keyring?: KeyringModule } = {}): Promise<CredentialStore> {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const index = new Index(path.join(dataDir, 'credentials.index.json'));
  if (opts.keyring || (!opts.forceFile && process.env.AO_CREDENTIAL_BACKEND !== 'file')) {
    try {
      const mod = opts.keyring ?? ((await import('@napi-rs/keyring')) as unknown as KeyringModule);
      // Probe: some Linux hosts have the library but no Secret Service running.
      const probe = new mod.Entry(SERVICE, '__probe__');
      probe.setPassword('ok');
      probe.deletePassword();
      const store = new OsKeyringStore(mod, index);
      await migrateFromFile(dataDir, store);
      return store;
    } catch (e) {
      log.warn({ err: String(e) }, 'OS credential store unavailable; using encrypted file store');
    }
  }
  return new EncryptedFileStore(dataDir);
}

export const WORKER_CREDENTIAL = 'worker-credential';
export const LOCAL_UI_TOKEN = 'local-ui-token';
