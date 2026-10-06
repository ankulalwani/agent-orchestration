/**
 * Bridge to the desktop app (apps/desktop), which shows this UI in its window. The app exposes a few
 * commands to this page (its capability `worker-ui`): a folder chooser, start at login, the log window,
 * a check for app updates, and opening links in the browser. In a browser none of this exists and the UI shows no desktop controls.
 */
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const invoke: Invoke | null = (window as unknown as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__?.core?.invoke ?? null;

export const isDesktop = invoke !== null;

/** The folder the user chose, or null when they cancelled. `start`: where the dialog opens, if that folder exists. */
export const pickFolder = (title: string, start?: string): Promise<string | null> => invoke!<string | null>('pick_folder', { title, start: start?.trim() || null });

export const autostart = {
  get: (): Promise<boolean> => invoke!<boolean>('autostart_get'),
  /** Resolves to whether the system accepted the change. */
  set: (enabled: boolean): Promise<boolean> => invoke!<boolean>('autostart_set', { enabled }),
};

export const openLogWindow = (): Promise<void> => invoke!<void>('open_logs');

/** Looks for a newer version of the app itself. The app shows the answer in its own dialog and asks before installing. */
export const checkAppUpdate = (): Promise<void> => invoke!<void>('check_app_update');

const openInBrowser = (url: string): void => void invoke!<void>('open_external', { url }).catch(() => undefined);

/**
 * Links that leave this UI (the dashboard's approval page, a provider's sign-in) belong in the user's
 * browser, where they are signed in. A desktop window has no tabs, so `target="_blank"` and `window.open`
 * would do nothing there.
 */
export function openOutsideLinksInBrowser(): void {
  if (!isDesktop) return;
  document.addEventListener(
    'click',
    (event) => {
      const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!link || link.origin === location.origin || !/^https?:$/.test(link.protocol)) return;
      event.preventDefault();
      openInBrowser(link.href);
    },
    true,
  );
  window.open = (url) => {
    if (url) openInBrowser(new URL(String(url), location.href).href);
    return null;
  };
}
