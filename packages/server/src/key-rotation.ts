import { createLogger } from '@ao/core';
import { GitHubApp, GitHubUserToken, Secret } from '@ao/database';
import type { SecretBox } from './crypto.js';
import { reencryptServerSettings } from './runtime-settings.js';

const log = createLogger('key-rotation');

export interface ReencryptResult {
  reencrypted: number;
  alreadyCurrent: number;
  /** Values no configured key can decrypt. They are left untouched, never overwritten. */
  failed: Array<{ organizationId: string; name: string; error: string }>;
}

/**
 * Re-encrypts every stored secret with the current ENCRYPTION_KEY (SEC-007). Safe to run repeatedly
 * and alongside a running server: each update is conditional on the ciphertext it read, so a secret
 * changed in the meantime is skipped rather than overwritten.
 */
export async function reencryptSecrets(box: SecretBox): Promise<ReencryptResult> {
  const result: ReencryptResult = { reencrypted: 0, alreadyCurrent: 0, failed: [] };
  for await (const s of Secret.find({}, { organizationId: 1, name: 1, valueEnc: 1 }).select('+valueEnc').lean().cursor()) {
    if (box.isCurrent(s.valueEnc)) {
      result.alreadyCurrent++;
      continue;
    }
    let plain: string;
    try {
      plain = box.decrypt(s.valueEnc);
    } catch (e) {
      result.failed.push({ organizationId: String(s.organizationId), name: s.name, error: (e as Error).message });
      continue;
    }
    const r = await Secret.updateOne({ _id: s._id, valueEnc: s.valueEnc }, { $set: { valueEnc: box.encrypt(plain) } });
    if (r.modifiedCount) result.reencrypted++;
  }
  // GitHub App credentials and members' GitHub authorizations.
  const encryptedFields: Array<{ model: typeof GitHubApp | typeof GitHubUserToken; label: string; fields: string[] }> = [
    { model: GitHubApp, label: 'GitHub App', fields: ['clientSecretEnc', 'privateKeyEnc', 'webhookSecretEnc'] },
    { model: GitHubUserToken, label: 'GitHub authorization', fields: ['accessTokenEnc', 'refreshTokenEnc'] },
  ];
  for (const { model, label, fields } of encryptedFields) {
    const m = model as unknown as typeof GitHubApp;
    for await (const d of m.find({}).select(fields.map((f) => `+${f}`).join(' ')).lean().cursor()) {
      const doc = d as unknown as Record<string, unknown> & { _id: unknown; organizationId: unknown };
      const set: Record<string, string> = {};
      const read: Record<string, unknown> = {};
      let failed = false;
      for (const f of fields) {
        const enc = doc[f];
        if (typeof enc !== 'string' || box.isCurrent(enc)) continue;
        try {
          set[f] = box.encrypt(box.decrypt(enc));
          read[f] = enc;
        } catch (e) {
          result.failed.push({ organizationId: String(doc.organizationId), name: `${label} ${f}`, error: (e as Error).message });
          failed = true;
        }
      }
      if (failed || !Object.keys(set).length) {
        if (!failed) result.alreadyCurrent++;
        continue;
      }
      const r = await m.updateOne({ _id: doc._id, ...read } as never, { $set: set });
      if (r.modifiedCount) result.reencrypted++;
    }
  }
  // Secret server settings saved in the web app (SELFHOST-002).
  const settings = await reencryptServerSettings(box);
  result.reencrypted += settings.reencrypted;
  for (const name of settings.failed) result.failed.push({ organizationId: '(server settings)', name, error: 'no configured key decrypts this value' });
  if (result.reencrypted || result.failed.length) log.info({ reencrypted: result.reencrypted, alreadyCurrent: result.alreadyCurrent, failed: result.failed.length }, 'secret re-encryption finished');
  for (const f of result.failed) log.error({ organizationId: f.organizationId, name: f.name, err: f.error }, 'secret could not be decrypted with any configured key');
  return result;
}
