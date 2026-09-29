// Opt-in: downloads VS Code (stable) and runs test/suite.cjs inside it with this extension loaded.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const dir = path.dirname(fileURLToPath(import.meta.url));
// Started from inside VS Code (its terminal or an extension), this is set and would make Code.exe run as
// plain Node.js.
delete process.env.ELECTRON_RUN_AS_NODE;
await runTests({
  extensionDevelopmentPath: path.resolve(dir, '..'),
  extensionTestsPath: path.resolve(dir, 'suite.cjs'),
  launchArgs: ['--disable-extensions', '--disable-workspace-trust', '--skip-welcome'],
});
