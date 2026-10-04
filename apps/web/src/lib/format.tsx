import { Badge, type Tone } from '@ao/ui';
import type { TaskStatus } from '@ao/core/shared';

const TASK_TONE: Record<TaskStatus, Tone> = {
  QUEUED: 'neutral',
  CLAIMING: 'info',
  PREPARING: 'info',
  RUNNING: 'accent',
  PAUSED: 'neutral',
  WAITING_FOR_LIMIT: 'warn',
  WAITING_FOR_INPUT: 'warn',
  WAITING_FOR_APPROVAL: 'warn',
  RECOVERY_REQUIRED: 'danger',
  CRASHED: 'danger',
  VERIFYING: 'info',
  COMPLETED: 'ok',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

export const humanize = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <Badge tone={TASK_TONE[status]} live={['RUNNING', 'VERIFYING', 'PREPARING', 'CLAIMING'].includes(status)}>
      {humanize(status)}
    </Badge>
  );
}

export function WorkerStatusBadge({ status }: { status: string }) {
  const tone: Tone = status === 'ONLINE' ? 'ok' : status === 'PENDING_APPROVAL' ? 'warn' : status === 'DISABLED' ? 'danger' : 'neutral';
  return <Badge tone={tone}>{humanize(status)}</Badge>;
}

export const NEEDS_HUMAN: TaskStatus[] = ['WAITING_FOR_INPUT', 'WAITING_FOR_APPROVAL', 'RECOVERY_REQUIRED', 'FAILED'];

/** What runs a task, as one compact line: agent / provider / model. Missing parts are left out. */
export function RunsOn({ agent, provider, model }: { agent?: string | null; provider?: string | null; model?: string | null }) {
  const parts = [agent, provider, model].filter(Boolean) as string[];
  if (!parts.length) return <span className="text-fg-3">—</span>;
  return (
    <span className="font-mono text-xs text-fg-2">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <span className="px-1 text-fg-3">/</span>}
          {p}
        </span>
      ))}
    </span>
  );
}
