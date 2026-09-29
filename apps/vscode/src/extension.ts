import * as vscode from 'vscode';
import path from 'node:path';
import { ApiError, OrchestratorClient } from './client.js';
import { chooseProject, createTask, reviewCurrentBranch, taskRows, taskUrl, type Context, type Ui } from './commands.js';

const TOKEN_KEY = 'agentOrchestrator.token';

/** VS Code entry point (FUT-007): commands, a task list in the Explorer, and sign-in with an API token. */
export function activate(context: vscode.ExtensionContext) {
  const settings = () => vscode.workspace.getConfiguration('agentOrchestrator');
  const serverUrl = () => String(settings().get('serverUrl') ?? '').trim();
  const webUrl = () => String(settings().get('webUrl') ?? '').trim() || serverUrl();

  const ui: Ui = {
    input: (o) => Promise.resolve(vscode.window.showInputBox({ title: o.title, prompt: o.prompt, value: o.value, password: o.password, ignoreFocusOut: true, validateInput: o.validate ? (v) => o.validate!(v) ?? undefined : undefined })),
    pick: async (items, placeholder) => (await vscode.window.showQuickPick(items.map((i) => ({ label: i.label, description: i.description, value: i.value })), { placeHolder: placeholder, ignoreFocusOut: true }))?.value,
    info: (m, ...a) => Promise.resolve(vscode.window.showInformationMessage(m, ...a)),
    error: (m) => void vscode.window.showErrorMessage(m),
    openExternal: (u) => void vscode.env.openExternal(vscode.Uri.parse(u)),
  };

  async function ctx(): Promise<Context | null> {
    const token = await context.secrets.get(TOKEN_KEY);
    if (!serverUrl() || !token) {
      const choice = await vscode.window.showWarningMessage('Sign in to Agent Orchestrator first.', 'Sign in');
      if (choice) await vscode.commands.executeCommand('agentOrchestrator.signIn');
      return null;
    }
    return { client: new OrchestratorClient(serverUrl(), token), ui, memory: context.workspaceState, webUrl: webUrl() };
  }

  const guarded = (fn: (c: Context) => Promise<unknown>) => async () => {
    const c = await ctx();
    if (!c) return;
    try {
      await fn(c);
      tasks.refresh();
    } catch (e) {
      ui.error(e instanceof ApiError && e.status === 401 ? 'The API token is invalid, expired or revoked. Sign in again.' : `Agent Orchestrator: ${(e as Error).message}`);
    }
  };

  // ── Task list ────────────────────────────────────────────────────────────
  type Row = ReturnType<typeof taskRows>[number];
  class TaskTree implements vscode.TreeDataProvider<Row> {
    private changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    refresh() {
      this.changed.fire();
    }
    getTreeItem(r: Row) {
      const item = new vscode.TreeItem(r.label);
      item.id = r.id;
      item.description = r.description;
      item.tooltip = r.tooltip;
      item.contextValue = 'task';
      item.iconPath = new vscode.ThemeIcon(r.icon, r.attention ? new vscode.ThemeColor('problemsWarningIcon.foreground') : undefined);
      item.command = { command: 'agentOrchestrator.openTask', title: 'Open', arguments: [r] };
      return item;
    }
    async getChildren() {
      const token = await context.secrets.get(TOKEN_KEY);
      if (!serverUrl() || !token) return [];
      try {
        const client = new OrchestratorClient(serverUrl(), token);
        const who = await client.whoami();
        return taskRows(await client.tasks(who.organizationId, context.workspaceState.get<string>('agentOrchestrator.projectId')));
      } catch (e) {
        return [{ id: 'error', label: `Could not load tasks: ${(e as Error).message}`, description: '', tooltip: '', icon: 'error', attention: true }];
      }
    }
  }
  const tasks = new TaskTree();
  const view = vscode.window.createTreeView('agentOrchestrator.tasks', { treeDataProvider: tasks });
  const timer = setInterval(() => view.visible && tasks.refresh(), 20_000);
  context.subscriptions.push(view, { dispose: () => clearInterval(timer) });

  // ── Commands ─────────────────────────────────────────────────────────────
  const register = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  register('agentOrchestrator.signIn', async () => {
    const url = await ui.input({ title: 'Agent Orchestrator server URL', value: serverUrl() || 'https://', validate: (v) => (/^https?:\/\/.+/.test(v.trim()) ? null : 'Enter an http(s) URL') });
    if (!url) return;
    const token = await ui.input({ title: 'Personal API token (Settings → Your account → API tokens)', password: true, validate: (v) => (v.trim().startsWith('aot_') ? null : 'API tokens start with aot_') });
    if (!token) return;
    try {
      const who = await new OrchestratorClient(url.trim(), token.trim()).whoami();
      await settings().update('serverUrl', url.trim(), vscode.ConfigurationTarget.Global);
      await context.secrets.store(TOKEN_KEY, token.trim());
      void vscode.window.showInformationMessage(`Signed in to ${who.organizationName} as ${who.email} (${who.role.toLowerCase()}).`);
      tasks.refresh();
    } catch (e) {
      ui.error(`Could not sign in: ${(e as Error).message}`);
    }
  });
  register('agentOrchestrator.signOut', async () => {
    await context.secrets.delete(TOKEN_KEY);
    tasks.refresh();
  });
  register('agentOrchestrator.chooseProject', guarded((c) => chooseProject(c, true)));
  register('agentOrchestrator.createTask', guarded((c) => createTask(c)));
  register(
    'agentOrchestrator.createTaskFromSelection',
    guarded(async (c) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return createTask(c);
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      const file = folder ? path.relative(folder.uri.fsPath, editor.document.uri.fsPath).split(path.sep).join('/') : path.basename(editor.document.uri.fsPath);
      return createTask(c, { text: editor.document.getText(editor.selection), file, startLine: editor.selection.start.line + 1, endLine: editor.selection.end.line + 1, languageId: editor.document.languageId });
    }),
  );
  register(
    'agentOrchestrator.reviewBranch',
    guarded(async (c) => {
      const folder = vscode.window.activeTextEditor ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri) : vscode.workspace.workspaceFolders?.[0];
      if (!folder) return ui.error('Open a folder first.');
      return reviewCurrentBranch(c, folder.uri.fsPath);
    }),
  );
  register('agentOrchestrator.refresh', () => tasks.refresh());
  register('agentOrchestrator.openTask', (r?: { id: string }) => r?.id && r.id !== 'error' && ui.openExternal(taskUrl(webUrl(), r.id)));
}

export function deactivate() {}
