// Runs inside a real VS Code (extension host): the extension activates and registers its commands and view.
const assert = require('node:assert');
const vscode = require('vscode');

exports.run = async function run() {
  const ext = vscode.extensions.getExtension('agent-orchestrator.agent-orchestrator-vscode');
  assert.ok(ext, 'extension is installed');
  await ext.activate();
  const commands = await vscode.commands.getCommands(true);
  const ours = ext.packageJSON.contributes.commands.map((c) => c.command);
  for (const c of ours) assert.ok(commands.includes(c), `command ${c} is registered`);
  // Without a server or token, the tree is empty rather than failing.
  await vscode.commands.executeCommand('agentOrchestrator.refresh');
  console.log(`VSCODE-EXTENSION-OK ${ours.length} commands, VS Code ${vscode.version}`);
};
