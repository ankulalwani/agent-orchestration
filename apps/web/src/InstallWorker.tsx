import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Alert, Button, Card, CopyButton, Skeleton, Tabs } from '@ao/ui';
import { get } from './lib/api';

type Os = 'windows' | 'macos' | 'linux';
type Method = 'desktop' | 'command';
interface InstallCommands { windows: string; macos: string; linux: string }
interface DesktopDownload { label: string; url: string }
interface InstallSettings { server: string; latest: string | null; trustedKeys: Record<string, string>; desktop?: Record<Os, DesktopDownload[]> }

const detectOs = (): Os => (/Windows/i.test(navigator.userAgent) ? 'windows' : /Mac/i.test(navigator.userAgent) ? 'macos' : 'linux');

/** What the system says when it meets an installer that is not code-signed, and what to do. */
const UNSIGNED: Record<Os, string | null> = {
  windows: 'The installer is not code-signed yet. Windows shows "Windows protected your PC": choose More info, then Run anyway.',
  macos: 'The app is not code-signed yet. macOS refuses the first start: open System Settings → Privacy & Security and choose Open Anyway.',
  linux: null,
};

/**
 * Two ways to put a worker on a machine: the desktop app (installers on the project's GitHub releases) or one
 * command that downloads the signed worker from this server. Both end on the approval page.
 */
export function InstallWorkerCard() {
  const [method, setMethod] = useState<Method>('desktop');
  const [os, setOs] = useState<Os>(detectOs);
  const commands = useQuery({ queryKey: ['install-commands'], queryFn: () => get<InstallCommands>('/install/commands') });
  const settings = useQuery({ queryKey: ['install-settings'], queryFn: () => get<InstallSettings>('/install/config') });
  const command = commands.data?.[os];
  const downloads = settings.data?.desktop?.[os] ?? [];
  const notReady = settings.data && (!settings.data.latest || Object.keys(settings.data.trustedKeys).length === 0);

  return (
    <Card title="Install the worker" padded={false}>
      <div className="px-4 pt-2">
        <Tabs<Method>
          label="Install method"
          value={method}
          onChange={setMethod}
          tabs={[{ id: 'desktop', label: 'Desktop app' }, { id: 'command', label: 'Command line' }]}
        />
      </div>
      <div className="px-4 pt-3">
        <p className="max-w-[80ch] text-fg-2">
          {method === 'desktop' ? (
            <>For your own computer: an app with a window and a tray icon. It brings its own Node.js, starts at login if you want, and shows a code that you approve here.</>
          ) : (
            <>Run this on the machine that has your code and AI agents. It installs the worker for your user, starts it at login, and opens a page where you click <strong>Approve</strong>. Requires Node.js 20+.</>
          )}
        </p>
      </div>
      <div className="px-4 pt-2">
        <Tabs<Os>
          label="Operating system"
          value={os}
          onChange={setOs}
          tabs={[{ id: 'windows', label: method === 'desktop' ? 'Windows' : 'Windows (PowerShell)' }, { id: 'macos', label: 'macOS' }, { id: 'linux', label: 'Linux' }]}
        />
      </div>
      {method === 'desktop' ? (
        <div className="flex flex-col gap-3 p-4">
          {settings.isLoading ? (
            <Skeleton className="h-10" />
          ) : downloads.length ? (
            <>
              <div className="flex flex-wrap gap-2">
                {downloads.map((d, i) => (
                  <Button key={d.url} asChild variant={i === 0 ? 'primary' : 'default'}>
                    <a href={d.url} rel="noreferrer"><Download size={14} aria-hidden="true" />{d.label}</a>
                  </Button>
                ))}
              </div>
              <p className="text-xs text-fg-3">The newest release, downloaded from {new URL(downloads[0]!.url).host}.</p>
              <p className="max-w-[80ch] text-fg-2">Start the app, open <strong>Connection</strong>, enter this address as the control plane URL and press <strong>Start pairing</strong>. The app shows a code and a button that opens the approval page here.</p>
              <div className="snippet">
                <code>{settings.data!.server}</code>
                <CopyButton value={settings.data!.server} label="Copy address" />
              </div>
              {UNSIGNED[os] && <Alert tone="warn">{UNSIGNED[os]}</Alert>}
            </>
          ) : (
            <Alert tone="warn">Could not load the download links.</Alert>
          )}
        </div>
      ) : (
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
      )}
    </Card>
  );
}
