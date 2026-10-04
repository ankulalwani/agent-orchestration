import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, CopyButton, Skeleton, Tabs } from '@ao/ui';
import { get } from './lib/api';

type Os = 'windows' | 'macos' | 'linux';
interface InstallCommands { windows: string; macos: string; linux: string }
interface InstallSettings { latest: string | null; trustedKeys: Record<string, string> }

const detectOs = (): Os => (/Windows/i.test(navigator.userAgent) ? 'windows' : /Mac/i.test(navigator.userAgent) ? 'macos' : 'linux');

/** One-line worker install: the command downloads the signed worker from this server, installs it, and opens the approval page. */
export function InstallWorkerCard() {
  const [os, setOs] = useState<Os>(detectOs);
  const commands = useQuery({ queryKey: ['install-commands'], queryFn: () => get<InstallCommands>('/install/commands') });
  const settings = useQuery({ queryKey: ['install-settings'], queryFn: () => get<InstallSettings>('/install/config') });
  const command = commands.data?.[os];
  const notReady = settings.data && (!settings.data.latest || Object.keys(settings.data.trustedKeys).length === 0);

  return (
    <Card title="Install the worker (one command)" padded={false}>
      <div className="px-4 pt-3">
        <p className="max-w-[80ch] text-fg-2">
          Run this on the machine that has your code and AI agents. It installs the worker for your user, starts it at login, and opens a page where you click <strong>Approve</strong>. Requires Node.js 20+.
        </p>
      </div>
      <div className="px-4 pt-2">
        <Tabs<Os>
          label="Operating system"
          value={os}
          onChange={setOs}
          tabs={[{ id: 'windows', label: 'Windows (PowerShell)' }, { id: 'macos', label: 'macOS' }, { id: 'linux', label: 'Linux' }]}
        />
      </div>
      <div className="flex flex-col gap-3 p-4">
        {commands.isLoading ? (
          <Skeleton className="h-10" />
        ) : command ? (
          <>
            <div className="snippet">
              <span className="select-none py-0.5 text-fg-3" aria-hidden="true">{os === 'windows' ? '>' : '$'}</span>
              <code>{command}</code>
              <CopyButton value={command} label="Copy command" />
            </div>
            <p className="text-xs text-fg-3">The command downloads a script from this server. Read it first at the address inside the command.</p>
          </>
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
