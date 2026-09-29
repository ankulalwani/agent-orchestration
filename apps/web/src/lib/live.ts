import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_PREFIX, liveMessage, type TaskDto, type WorkerDto } from '@ao/contracts';
import { backoffDelay } from '@ao/core/shared';
import { getAccessToken, refreshSession } from './api';

export type LiveState = 'connecting' | 'live' | 'polling';

/**
 * Real-time updates over WebSocket (spec §54). Updates are written straight into the query cache.
 * If the socket is down, queries fall back to interval polling (see `refetchInterval` in queries).
 */
export function useLive(orgId: string | null): LiveState {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>('connecting');

  useEffect(() => {
    if (!orgId) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      let token = getAccessToken();
      if (!token) token = (await refreshSession())?.accessToken ?? null;
      if (!token || closed) return;
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${API_PREFIX}/live`;
      ws = new WebSocket(url);
      ws.onopen = () => ws?.send(JSON.stringify({ type: 'auth', token, organizationId: orgId }));
      ws.onmessage = (ev) => {
        const data = JSON.parse(String(ev.data));
        if (data.type === 'ready') {
          attempt = 0;
          setState('live');
          return;
        }
        const msg = liveMessage.safeParse(data);
        if (!msg.success) return;
        const m = msg.data;
        if (m.type === 'task.updated') {
          qc.setQueryData(['task', orgId, m.task.id], m.task);
          // Task lists are cached either as a page ({items}) or as an infinite query ({pages:[{items}]}).
          type Page = { items: TaskDto[] };
          const patchPage = (p: Page): Page => ({ ...p, items: p.items.map((t) => (t.id === m.task.id ? m.task : t)) });
          let found = false;
          qc.setQueriesData<Page | { pages: Page[] }>({ queryKey: ['tasks', orgId] }, (old) => {
            if (!old) return old;
            if ('pages' in old) {
              if (old.pages.some((p) => p.items.some((t) => t.id === m.task.id))) found = true;
              return { ...old, pages: old.pages.map(patchPage) };
            }
            if (old.items?.some((t) => t.id === m.task.id)) found = true;
            return old.items ? patchPage(old) : old;
          });
          void qc.invalidateQueries({ queryKey: ['overview', orgId] });
          if (!found) void qc.invalidateQueries({ queryKey: ['tasks', orgId] });
        } else if (m.type === 'task.event') {
          qc.setQueryData<{ items: unknown[] }>(['events', orgId, m.event.taskId], (old) => (old ? { ...old, items: [...old.items, m.event] } : old));
          if (m.event.type === 'AgentOutput') qc.setQueryData<{ items: unknown[] }>(['output', orgId, m.event.taskId], (old) => (old ? { ...old, items: [...old.items, m.event] } : old));
        } else if (m.type === 'worker.updated') {
          qc.setQueryData<WorkerDto[]>(['workers', orgId], (old) => (old ? old.map((w) => (w.id === m.worker.id ? { ...w, ...m.worker, activeTaskIds: w.activeTaskIds } : w)) : old));
          qc.setQueryData<WorkerDto>(['worker', orgId, m.worker.id], (old) => (old ? { ...old, ...m.worker, activeTaskIds: old.activeTaskIds } : old));
          void qc.invalidateQueries({ queryKey: ['worker', orgId, m.worker.id] });
          void qc.invalidateQueries({ queryKey: ['overview', orgId] });
        } else if (m.type === 'notification') {
          void qc.invalidateQueries({ queryKey: ['notifications', orgId] });
        }
      };
      ws.onclose = () => {
        ws = null;
        if (closed) return;
        setState('polling');
        timer = setTimeout(() => void connect(), backoffDelay(attempt++, 1000, 30_000));
      };
    };
    void connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [orgId, qc]);

  return state;
}
