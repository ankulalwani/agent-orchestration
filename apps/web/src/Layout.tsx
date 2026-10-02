import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { OverviewDto } from '@ao/contracts';
import { Badge, Button, Select } from '@ao/ui';
import { useSession } from './lib/session';
import { useLive } from './lib/live';
import { get, logout } from './lib/api';
import { useWebExtension } from './extension';

export function Layout() {
  const { session, org, setOrgId, can } = useSession();
  const ext = useWebExtension();
  const navCtx = { can, platformAdmin: Boolean(session!.user.platformAdmin) };
  const extNav = (section: 'organization' | 'server') =>
    (ext.nav ?? []).filter((n) => n.section === section && (n.visible?.(navCtx) ?? true)).map((n) => <span key={n.to}>{link(n.to, n.label)}</span>);
  const orgId = org!.organizationId;
  const live = useLive(orgId);
  const [menuOpen, setMenuOpen] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => setMenuOpen(false), [loc.pathname]);

  const overview = useQuery({ queryKey: ['overview', orgId], queryFn: () => get<OverviewDto>(`/orgs/${orgId}/overview`), refetchInterval: live === 'live' ? 60_000 : 15_000 });
  const unread = useQuery({ queryKey: ['notifications', orgId, 'count'], queryFn: () => get<{ unread: number }>(`/orgs/${orgId}/notifications?limit=1`), refetchInterval: 60_000 });
  const attention = (overview.data?.recoveryRequired ?? 0) + (overview.data?.pendingApprovals ?? 0) + (overview.data?.needsAttention.filter((t) => t.status === 'WAITING_FOR_INPUT').length ?? 0);

  const link = (to: string, label: string, badge?: number) => (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
      <span>{label}</span>
      {badge ? <span className="count" aria-label={`${badge} need attention`}>{badge}</span> : null}
    </NavLink>
  );

  return (
    <div className="shell">
      <aside className={`sidebar${menuOpen ? ' open' : ''}`} aria-label="Main navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">▲</span>
          Agent Orchestration
        </div>
        {session!.memberships.length > 1 && (
          <div className="field">
            <label htmlFor="org-switch" className="sr-only">Organization</label>
            <Select id="org-switch" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              {session!.memberships.map((m) => (
                <option key={m.organizationId} value={m.organizationId}>{m.organizationName}</option>
              ))}
            </Select>
          </div>
        )}
        <nav className="nav">
          {link('/', 'Overview', attention)}
          {link('/tasks', 'Tasks')}
          {link('/projects', 'Projects')}
          {link('/workers', 'Workers')}
          <div className="nav-section">AI</div>
          {link('/agents', 'Agents')}
          {link('/providers', 'AI models')}
          {link('/capabilities', 'Capabilities')}
          <div className="nav-section">Organization</div>
          {link('/notifications', 'Notifications', unread.data?.unread)}
          {can('audit.read') && link('/audit', 'Audit log')}
          {link('/settings', 'Settings')}
          {extNav('organization')}
          {link('/welcome', 'Getting started')}
          {session!.user.platformAdmin && (
            <>
              <div className="nav-section">Server</div>
              {link('/admin/server', 'Server settings')}
              {link('/admin/users', 'Users')}
              {link('/admin/features', 'Feature flags')}
              {link('/admin/updates', 'Updates')}
              {link('/admin/releases', 'Worker releases')}
              {link('/admin/marketplace', 'Marketplace')}
              {extNav('server')}
            </>
          )}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="row">
            <Button variant="ghost" className="menu-toggle" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>☰</Button>
            <strong className="hide-mobile">{org!.organizationName}</strong>
            <Badge tone="neutral">{org!.role.toLowerCase()}</Badge>
          </div>
          <div className="row">
            <Badge tone={live === 'live' ? 'ok' : 'warn'} live={live === 'live'}>
              {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting' : 'Polling'}
            </Badge>
            {can('task.create') && <Button variant="primary" size="sm" onClick={() => nav('/tasks?new=1')}>New task</Button>}
            <span className="muted small hide-mobile">{session!.user.email}</span>
            <Button size="sm" variant="ghost" onClick={() => void logout().then(() => nav('/login'))}>Sign out</Button>
          </div>
        </header>
        <main className="content" id="main">
          {ext.Banner && <ext.Banner />}
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}
