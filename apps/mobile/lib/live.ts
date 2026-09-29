import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { API_PREFIX } from '@ao/contracts';
import { backoffDelay } from '@ao/core/shared';
import { getAccessToken, getServer, refresh } from './api';

/**
 * Live updates over the same WebSocket as the web app (spec §54). On any update the relevant queries
 * are invalidated; screens also poll as a fallback. Disconnects while the app is in the background.
 */
export function useLive(orgId: string) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!orgId) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      const server = getServer();
      const token = getAccessToken() ?? (await refresh())?.accessToken;
      if (!server || !token || closed) return;
      ws = new WebSocket(server.replace(/^http/, 'ws') + API_PREFIX + '/live');
      ws.onopen = () => ws?.send(JSON.stringify({ type: 'auth', token, organizationId: orgId }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as { type: string; task?: { id: string }; event?: { taskId: string } };
        if (m.type === 'ready') attempt = 0;
        if (m.type === 'task.updated' && m.task) {
          qc.setQueryData(['task', orgId, m.task.id], m.task);
          void qc.invalidateQueries({ queryKey: ['tasks', orgId] });
          void qc.invalidateQueries({ queryKey: ['overview', orgId] });
        }
        if (m.type === 'task.event' && m.event) void qc.invalidateQueries({ queryKey: ['events', orgId, m.event.taskId] });
        if (m.type === 'worker.updated') void qc.invalidateQueries({ queryKey: ['workers', orgId] });
        if (m.type === 'notification') void qc.invalidateQueries({ queryKey: ['notifications', orgId] });
      };
      ws.onclose = () => {
        ws = null;
        if (!closed) timer = setTimeout(() => void connect(), backoffDelay(attempt++, 1000, 30_000));
      };
    };
    void connect();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && !ws) void connect();
      if (s === 'background') ws?.close();
    });
    return () => {
      closed = true;
      clearTimeout(timer);
      sub.remove();
      ws?.close();
    };
  }, [orgId, qc]);
}
