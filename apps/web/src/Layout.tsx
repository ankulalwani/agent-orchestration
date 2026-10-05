import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity, Bell, Bot, CalendarClock, ChartColumn, ChevronsUpDown, CircleDot, Compass, Cpu, Flag, FolderGit2, LayoutTemplate, ListChecks, LogOut, Menu as MenuIcon, Moon, Package, Plus, Puzzle, RefreshCw, ScrollText, Server, Settings, SlidersHorizontal, Store, Sun, Users } from 'lucide-react';
import type { OverviewDto } from '@ao/contracts';
import { Badge, Button, Menu, MenuItem, MenuLabel, MenuSeparator, Select, cn, useTheme } from '@ao/ui';
import { useSession } from './lib/session';
import { useLive } from './lib/live';
import { get, logout } from './lib/api';
import { useWebExtension } from './extension';

type NavIcon = ComponentType<{ className?: string }>;

/** The product mark: a rising chevron, the same shape as the favicon. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-6 flex-none', className)} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M9 22l7-12 7 12" stroke="var(--on-accent)" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Layout() {
  const { session, org, setOrgId, can } = useSession();
  const ext = useWebExtension();
  const navCtx = { can, platformAdmin: Boolean(session!.user.platformAdmin) };
  const extNav = (section: 'organization' | 'server') =>
    (ext.nav ?? []).filter((n) => n.section === section && (n.visible?.(navCtx) ?? true)).map((n) => <span key={n.to} className="contents">{link(n.to, n.label, n.icon ?? CircleDot)}</span>);
  const orgId = org!.organizationId;
  const live = useLive(orgId);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => setMenuOpen(false), [loc.pathname]);

  const overview = useQuery({ queryKey: ['overview', orgId], queryFn: () => get<OverviewDto>(`/orgs/${orgId}/overview`), refetchInterval: live === 'live' ? 60_000 : 15_000 });
  const unread = useQuery({ queryKey: ['notifications', orgId, 'count'], queryFn: () => get<{ unread: number }>(`/orgs/${orgId}/notifications?limit=1`), refetchInterval: 60_000 });
  const attention = (overview.data?.recoveryRequired ?? 0) + (overview.data?.pendingApprovals ?? 0) + (overview.data?.needsAttention.filter((t) => t.status === 'WAITING_FOR_INPUT').length ?? 0);

  const link = (to: string, label: string, Icon: NavIcon, badge?: number) => (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        cn(
          'group relative flex h-[30px] items-center gap-2.5 rounded-sm px-2 font-medium text-fg-2 hover:bg-surface-2 hover:text-fg hover:no-underline',
          isActive && 'active bg-surface-2 text-fg before:absolute before:inset-y-1.5 before:-left-2 before:w-0.5 before:rounded-full before:bg-brand',
        )
      }
    >
      <Icon className="size-[15px] flex-none text-fg-3 group-hover:text-fg-2 group-[.active]:text-brand" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge ? (
        <span className="min-w-[18px] rounded-sm bg-danger px-1 text-center text-2xs font-semibold text-bg tabular-nums" aria-label={`${badge} need attention`}>
          {badge}
        </span>
      ) : null}
    </NavLink>
  );
  const section = (label: string) => <div className="px-2 pb-1 pt-4 text-xs text-fg-3">{label}</div>;
  const user = session!.user;
  const initial = (user.name || user.email).trim().charAt(0).toUpperCase();

  return (
    <div className="grid min-h-dvh grid-cols-1 min-[861px]:grid-cols-[224px_minmax(0,1fr)]">
      {menuOpen && <div className="fixed inset-0 z-30 bg-backdrop min-[861px]:hidden" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
      <aside
        className={cn(
          'sticky top-0 z-40 flex h-dvh flex-col border-r border-line bg-surface',
          'max-[860px]:fixed max-[860px]:inset-y-0 max-[860px]:left-0 max-[860px]:w-[260px] max-[860px]:-translate-x-full max-[860px]:shadow-pop max-[860px]:transition-transform',
          menuOpen && 'max-[860px]:translate-x-0',
        )}
        aria-label="Main navigation"
      >
        <div className="flex h-12 flex-none items-center gap-2.5 border-b border-line px-4 font-semibold">
          <BrandMark />
          <span className="truncate">Agent Orchestration</span>
        </div>
        {session!.memberships.length > 1 && (
          <div className="px-3 pt-3">
            <label htmlFor="org-switch" className="sr-only">Organization</label>
            <Select id="org-switch" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              {session!.memberships.map((m) => (
                <option key={m.organizationId} value={m.organizationId}>{m.organizationName}</option>
              ))}
            </Select>
          </div>
        )}
        <nav className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-4 py-3">
          {link('/', 'Overview', Activity, attention)}
          {link('/tasks', 'Tasks', ListChecks)}
          {link('/schedules', 'Schedules', CalendarClock)}
          {link('/templates', 'Templates', LayoutTemplate)}
          {link('/projects', 'Projects', FolderGit2)}
          {link('/workers', 'Workers', Server)}
          {link('/insights', 'Insights', ChartColumn)}
          {section('AI')}
          {link('/agents', 'Agents', Bot)}
          {link('/providers', 'AI models', Cpu)}
          {link('/capabilities', 'Capabilities', Puzzle)}
          {section('Organization')}
          {link('/notifications', 'Notifications', Bell, unread.data?.unread)}
          {can('audit.read') && link('/audit', 'Audit log', ScrollText)}
          {link('/settings', 'Settings', Settings)}
          {extNav('organization')}
          {link('/welcome', 'Getting started', Compass)}
          {user.platformAdmin && (
            <>
              {section('Server')}
              {link('/admin/server', 'Server settings', SlidersHorizontal)}
              {link('/admin/users', 'Users', Users)}
              {link('/admin/features', 'Feature flags', Flag)}
              {link('/admin/updates', 'Updates', RefreshCw)}
              {link('/admin/releases', 'Worker releases', Package)}
              {link('/admin/marketplace', 'Marketplace', Store)}
              {extNav('server')}
            </>
          )}
        </nav>
        <div className="flex-none border-t border-line p-2">
          <Menu
            side="top"
            align="start"
            trigger={
              <button type="button" className="flex w-full items-center gap-2.5 rounded-sm p-2 text-left hover:bg-surface-2">
                <span className="grid size-7 flex-none place-items-center rounded-sm bg-brand-soft text-xs font-semibold text-brand" aria-hidden="true">{initial}</span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate font-medium">{user.name || 'Account'}</span>
                  <span className="block truncate text-xs text-fg-3">{user.email}</span>
                </span>
                <ChevronsUpDown className="size-3.5 flex-none text-fg-3" aria-hidden="true" />
              </button>
            }
          >
            <MenuLabel>Signed in to {org!.organizationName}</MenuLabel>
            <MenuItem icon={Settings} onSelect={() => nav('/settings')}>Settings</MenuItem>
            <MenuItem icon={theme === 'dark' ? Sun : Moon} onSelect={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</MenuItem>
            <MenuSeparator />
            <MenuItem icon={LogOut} onSelect={() => void logout().then(() => nav('/login'))}>Sign out</MenuItem>
          </Menu>
        </div>
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-12 flex-none items-center justify-between gap-3 border-b border-line bg-bg/85 px-4 backdrop-blur min-[861px]:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="ghost" size="icon" className="menu-toggle" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
              <MenuIcon aria-hidden="true" />
            </Button>
            <strong className="hide-mobile truncate">{org!.organizationName}</strong>
            <Badge plain>{org!.role.toLowerCase()}</Badge>
          </div>
          <div className="flex flex-none items-center gap-2">
            <Badge tone={live === 'live' ? 'ok' : 'warn'} live={live === 'live'}>
              {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting' : 'Polling'}
            </Badge>
            {can('task.create') && (
              <Button variant="primary" size="sm" onClick={() => nav('/tasks?new=1')}>
                <Plus aria-hidden="true" />
                New task
              </Button>
            )}
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 p-4 min-[861px]:p-6" id="main">
          {ext.Banner && <ext.Banner />}
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, actions, crumb }: { title: string; description?: ReactNode; actions?: ReactNode; /** A line above the title: where this page sits. */ crumb?: ReactNode }) {
  return (
    <div className="page-header">
      <div className="min-w-0">
        {crumb && <div className="mb-1 text-xs text-fg-3">{crumb}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}
