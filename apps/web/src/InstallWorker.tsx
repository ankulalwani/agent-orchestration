import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Spinner, Tabs } from '@ao/ui';
import { get } from './lib/api';

type Os = 'windows' | 'macos' | 'linux';
interface InstallCommands { windows: string; macos: string; linux: string }
interface InstallSettings { latest: string | null; trustedKeys: Record<string, string> }

const detectOs = (): Os => (/Windows/i.test(navigator.userAgent) ? 'windows' : /Mac/i.test(navigator.userAgent) ? 'macos' : 'linux');

/** One-line worker install: the command downloads the signed worker from this server, installs it, and opens the approval page. */
export function InstallWorkerCard() {
  const [os, setOs] = useState<Os>(detectOs);
  const [copied, setCopied] = useState(false);
  const commands = useQuery({ queryKey: ['install-commands'], queryFn: () => get<InstallCommands>('/install/commands') });
  const settings = useQuery({ queryKey: ['install-settings'], queryFn: () => get<InstallSettings>('/install/config') });
  const command = commands.data?.[os];
  const notReady = settings.data && (!settings.data.latest || Object.keys(settings.data.trustedKeys).length === 0);

  return (
    <Card title="Install the worker (one command)">
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          Run this on the machine that has your code and AI agents. It installs the worker for your user, starts it at login, and opens a page where you click <strong>Approve</strong>. Requires Node.js 20+.
        </p>
        <Tabs<Os>
          label="Operating system"
          value={os}
          onChange={(v) => { setOs(v); setCopied(false); }}
          tabs={[{ id: 'windows', label: 'Windows (PowerShell)' }, { id: 'macos', label: 'macOS' }, { id: 'linux', label: 'Linux' }]}
        />
        {commands.isLoading ? (
          <Spinner />
        ) : command ? (
          <div className="stack">
            <pre className="log" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{command}</pre>
            <div className="row">
              <Button
                variant="primary"
                onClick={() => {
                  void navigator.clipboard?.writeText(command).then(() => setCopied(true));
                }}
              >
                {copied ? 'Copied' : 'Copy command'}
              </Button>
              <span className="muted small">The command downloads a script from this server. Read it first at the address inside the command.</span>
            </div>
          </div>
        ) : (
          <Alert tone="warn">Could not load the install command.</Alert>
        )}
        {notReady && (
          <Alert tone="warn">
            This server can't install workers yet.{' '}
            {!settings.data?.latest && 'No worker release is available yet: an administrator opens Server → Worker releases and presses "Update workers".'}{' '}
            {Object.keys(settings.data?.trustedKeys ?? {}).length === 0 && 'This server lists no release signing key, so a download cannot be verified.'}
          </Alert>
        )}
      </div>
    </Card>
  );
}
