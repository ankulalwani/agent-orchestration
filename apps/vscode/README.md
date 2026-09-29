# Agent Orchestration for VS Code

Hand work to coding agents without leaving the editor.

- **Create task from selection** (editor context menu): describe what to do with the selected code.
  The task's prompt includes the code, its file and its lines.
- **Create task…**: any task for the workspace's project.
- **Review the current branch**: an agent reviews the branch against a base branch (default: the remote's
  default branch) and changes nothing. The review appears in the dashboard, and on the pull request
  when the project's integration posts reviews.
- **Agent tasks** in the Explorer: the workspace project's recent tasks with their status. Tasks that
  need you (input, approval, recovery, failure) are highlighted. Click one to open it in the dashboard.

## Sign in

1. In the dashboard, open **Settings → Your account → API tokens** and create a token for your
   organization (for example with the *Developer* role).
2. In VS Code, run **Agent Orchestration: Sign in with an API token** and enter the server URL and the token.
   The token is kept in VS Code's secret storage.

The first task from a workspace asks which project it belongs to, and the answer is remembered for that
workspace (**Agent Orchestration: Choose project for this workspace** changes it). Set
`agentOrchestration.webUrl` if the dashboard is not served from the server URL.

## Build

```bash
pnpm --filter agent-orchestration-vscode build      # dist/extension.js
cd apps/vscode && npx @vscode/vsce package --no-dependencies   # agent-orchestration-vscode-0.1.0.vsix
```

Install the `.vsix` with **Extensions → … → Install from VSIX**.
