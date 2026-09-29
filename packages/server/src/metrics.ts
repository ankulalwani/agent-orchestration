import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus metrics (spec §61). Names follow the spec list. */
export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'ao_' });
  const c = (name: string, help: string, labelNames: string[] = []) => new Counter({ name, help, labelNames, registers: [registry] });
  const g = (name: string, help: string, labelNames: string[] = []) => new Gauge({ name, help, labelNames, registers: [registry] });
  return {
    registry,
    tasksCreated: c('tasks_created_total', 'Tasks created'),
    tasksCompleted: c('tasks_completed_total', 'Tasks completed'),
    tasksFailed: c('tasks_failed_total', 'Tasks failed'),
    tasksWaitingForLimit: c('tasks_waiting_for_limit_total', 'Transitions into WAITING_FOR_LIMIT', ['provider']),
    agentSessions: c('agent_sessions_total', 'Agent sessions started', ['agent']),
    verificationFailures: c('verification_failures_total', 'Verification runs that failed'),
    fallbackCount: c('fallback_count', 'Fallbacks to another agent/provider/model', ['from_provider', 'to_provider']),
    providerLimitCount: c('provider_limit_count', 'Provider limit events', ['provider']),
    leaseExpirations: c('lease_expirations_total', 'Leases that expired and were recovered'),
    workerOnline: g('worker_online_count', 'Workers online'),
    workerOffline: g('worker_offline_count', 'Workers offline'),
    queueDepth: g('queue_depth', 'Dispatch queue depth'),
    tasksByStatus: g('tasks_by_status', 'Tasks per status', ['status']),
    taskExecutionSeconds: new Histogram({
      name: 'task_execution_seconds',
      help: 'Active execution time of finished tasks (excludes waiting)',
      buckets: [30, 60, 300, 900, 1800, 3600, 7200, 14400],
      registers: [registry],
    }),
    httpRequests: c('http_requests_total', 'HTTP requests', ['method', 'route', 'status']),
  };
}
export type Metrics = ReturnType<typeof createMetrics>;
