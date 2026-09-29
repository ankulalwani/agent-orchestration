#!/usr/bin/env node
// Release signing for worker updates (spec §66).
//   node scripts/sign-release.mjs keygen <keyId>                 → writes <keyId>.private.pem / <keyId>.public.pem
//   node scripts/sign-release.mjs sign <keyId>.private.pem <keyId> <package.tgz> <version> <packageUrl> [channel]
// Keep the private key offline (e.g. in a CI secret or HSM). Ship the public key with workers.
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';

const [cmd, ...args] = process.argv.slice(2);
const canonical = (m) => Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]))), 'utf8');

if (cmd === 'keygen') {
  const [keyId] = args;
  if (!keyId) throw new Error('usage: keygen <keyId>');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  fs.writeFileSync(`${keyId}.private.pem`, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(`${keyId}.public.pem`, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`Wrote ${keyId}.private.pem (keep secret) and ${keyId}.public.pem`);
} else if (cmd === 'sign') {
  const [privPath, keyId, pkg, version, packageUrl, channel = 'stable'] = args;
  if (!privPath || !keyId || !pkg || !version || !packageUrl) throw new Error('usage: sign <private.pem> <keyId> <package.tgz> <version> <packageUrl> [channel]');
  const manifest = {
    version,
    channel,
    publishedAt: new Date().toISOString(),
    packageUrl,
    sha256: createHash('sha256').update(fs.readFileSync(pkg)).digest('hex'),
    minNodeVersion: '20.0.0',
    notes: '',
  };
  const signature = sign(null, canonical(manifest), createPrivateKey(fs.readFileSync(privPath))).toString('base64');
  process.stdout.write(JSON.stringify({ manifest, signature, keyId }, null, 2) + '\n');
} else {
  console.log('usage: sign-release.mjs keygen <keyId> | sign <private.pem> <keyId> <package.tgz> <version> <packageUrl> [channel]');
  process.exit(1);
}
