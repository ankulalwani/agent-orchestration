import { runCommandFromArgv } from './commands.js';
import { exitOnStartupFailure, startControlPlane } from './server.js';

// `node dist/main.js <command>` runs a one-off command (see commands.ts); otherwise the control plane starts.
if (!runCommandFromArgv()) startControlPlane().catch(exitOnStartupFailure());
