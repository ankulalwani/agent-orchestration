import { connectDatabase, disconnectDatabase, User } from '@ao/database';
import { SecretBox, audit, createServices, loadServerConfig, reencryptSecrets, seedDemo } from '@ao/server';

/** `node dist/main.js reencrypt-secrets`: re-encrypt stored secrets with the current ENCRYPTION_KEY, then exit. */
async function reencryptCommand() {
  const config = loadServerConfig();
  await connectDatabase({ uri: config.MONGODB_URI });
  const r = await reencryptSecrets(new SecretBox(config.ENCRYPTION_KEY, config.ENCRYPTION_KEYS_PREVIOUS));
  await disconnectDatabase();
  console.log(JSON.stringify(r, null, 2));
  if (r.failed.length) {
    console.error(`${r.failed.length} secret(s) could not be decrypted with any configured key. Keep ENCRYPTION_KEYS_PREVIOUS until they are fixed.`);
    process.exit(2);
  }
  console.log('All secrets use the current key. ENCRYPTION_KEYS_PREVIOUS can now be removed.');
}

/** `node dist/main.js seed-demo`: demo data for a new installation (SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD). */
async function seedCommand() {
  const config = loadServerConfig();
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (at least 10 characters) for the administrator account');
  await connectDatabase({ uri: config.MONGODB_URI });
  const services = await createServices(config);
  const r = await seedDemo(services, { email, password });
  await services.queue.close();
  await disconnectDatabase();
  console.log(`Demo data created. Sign in as ${email}. Organization ${r.organizationId}, project ${r.projectId}.`);
}

/** `node dist/main.js platform-admin <email> [--revoke]`: grant (or revoke) the platform administrator role. */
async function platformAdminCommand(args: string[]) {
  const email = args.find((a) => !a.startsWith('--'));
  if (!email) throw new Error('usage: platform-admin <email> [--revoke]');
  const grant = !args.includes('--revoke');
  const config = loadServerConfig();
  await connectDatabase({ uri: config.MONGODB_URI });
  try {
    const user = await User.findOneAndUpdate({ email: email.trim().toLowerCase() }, { $set: { platformAdmin: grant } }).lean();
    if (!user) throw new Error(`No account with the email ${email}. The person must sign up first.`);
    await audit({ system: true }, grant ? 'user.platform_admin_granted' : 'user.platform_admin_revoked', { type: 'user', id: String(user._id) }, { via: 'command' });
    console.log(`${email} is ${grant ? 'now' : 'no longer'} a platform administrator (takes effect at their next sign-in or token refresh).`);
  } finally {
    await disconnectDatabase();
  }
}

/** One-off administration commands: `node dist/main.js <command> [args]`. */
export const controlPlaneCommands: Record<string, (args: string[]) => Promise<void>> = {
  'reencrypt-secrets': () => reencryptCommand(),
  'seed-demo': () => seedCommand(),
  'platform-admin': platformAdminCommand,
};

/** Runs the command named in argv[2] (plain messages, then exit), or returns false when there is none. */
export function runCommandFromArgv(argv = process.argv): boolean {
  const command = argv[2] ? controlPlaneCommands[argv[2]] : undefined;
  if (!command) return false;
  command(argv.slice(3))
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    });
  return true;
}
