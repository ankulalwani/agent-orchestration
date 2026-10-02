import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import '@ao/ui/styles.css';
import './app.css';
import { SessionProvider, useSession } from './lib/session';
import { ApiError } from './lib/api';
import { Layout } from './Layout';
import { InvitePage, LoginPage, OAuthCompletePage, RegisterPage, ResetPasswordPage } from './pages/Auth';
import { OverviewPage } from './pages/Overview';
import { TasksPage } from './pages/Tasks';
import { TaskDetailPage } from './pages/TaskDetail';
import { ProjectsPage, ProjectDetailPage } from './pages/Projects';
import { WorkersPage, WorkerDetailPage, PairPage } from './pages/Workers';
import { AgentsPage, ProvidersPage } from './pages/AgentsProviders';
import { CapabilitiesPage } from './pages/Capabilities';
import { AuditPage } from './pages/Audit';
import { NotificationsPage } from './pages/Notifications';
import { SettingsPage } from './pages/Settings';
import { OnboardingPage } from './pages/Onboarding';
import { AdminServerPage } from './pages/AdminServer';
import { AdminFeaturesPage } from './pages/AdminFeatures';
import { AdminUsersPage } from './pages/AdminUsers';
import { DeviceLoginPage } from './pages/DeviceLogin';
import { AdminReleasesPage } from './pages/AdminReleases';
import { AdminUpdatesPage } from './pages/AdminUpdates';
import { AdminMarketplacePage } from './pages/AdminMarketplace';
import { Spinner } from '@ao/ui';
import { WebExtensionProvider, type WebExtension } from './extension';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

function Protected() {
  const { session, loading, org } = useSession();
  if (loading) return <div className="center-screen"><Spinner label="Loading…" /></div>;
  if (!session) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (!org) return <div className="center-screen">You are not a member of any organization.</div>;
  return <Layout />;
}

/** Renders the dashboard; `extension` adds a distribution's pages, navigation and notices (see extension.tsx). */
export function renderWebApp(extension: WebExtension = {}, root: HTMLElement = document.getElementById('root')!) {
  createRoot(root).render(
    <StrictMode>
      <WebExtensionProvider value={extension}>
        <QueryClientProvider client={queryClient}>
          <SessionProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/reset-password" element={<ResetPasswordPage />} />
                <Route path="/invite" element={<InvitePage />} />
                <Route path="/oauth/complete" element={<OAuthCompletePage />} />
                <Route element={<Protected />}>
                  <Route index element={<OverviewPage />} />
                  <Route path="/welcome" element={<OnboardingPage />} />
                  <Route path="/tasks" element={<TasksPage />} />
                  <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
                  <Route path="/projects" element={<ProjectsPage />} />
                  <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
                  <Route path="/workers" element={<WorkersPage />} />
                  <Route path="/workers/:workerId" element={<WorkerDetailPage />} />
                  <Route path="/pair" element={<PairPage />} />
                  <Route path="/device" element={<DeviceLoginPage />} />
                  <Route path="/agents" element={<AgentsPage />} />
                  <Route path="/providers" element={<ProvidersPage />} />
                  <Route path="/capabilities" element={<CapabilitiesPage />} />
                  <Route path="/audit" element={<AuditPage />} />
                  <Route path="/notifications" element={<NotificationsPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="/admin/server" element={<AdminServerPage />} />
                  <Route path="/admin/features" element={<AdminFeaturesPage />} />
                  <Route path="/admin/users" element={<AdminUsersPage />} />
                  <Route path="/admin/releases" element={<AdminReleasesPage />} />
                  <Route path="/admin/updates" element={<AdminUpdatesPage />} />
                  <Route path="/admin/marketplace" element={<AdminMarketplacePage />} />
                  {extension.routes?.map((r) => <Route key={r.path} path={r.path} element={r.element} />)}
                  <Route path="*" element={<div className="empty"><h3>Page not found</h3></div>} />
                </Route>
              </Routes>
            </BrowserRouter>
          </SessionProvider>
        </QueryClientProvider>
      </WebExtensionProvider>
    </StrictMode>,
  );
}
