/**
 * Public keys that sign the project's official worker releases (GitHub Releases of the upstream repository).
 * Servers and workers trust these by default, so a self-hosted install can update its workers without
 * generating, configuring or distributing any key. The matching private key exists only as a secret of the
 * upstream release workflow (WORKER_RELEASE_SIGNING_KEY). To rotate, add the new key here, release, then
 * retire the old one in a later version.
 */
export const PROJECT_RELEASE_KEYS: Readonly<Record<string, string>> = {
  'ao-release-1': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAht3UADZkwavLThMwm/XLqYpZ7qILgWNLLBw3J0mnMdM=\n-----END PUBLIC KEY-----\n',
};
