/** Normalized agent states (spec §8). Adapters map agent-specific signals onto these. */
export const AGENT_STATES = [
  'INSTALLATION_NOT_FOUND',
  'STARTING',
  'RUNNING',
  'IDLE',
  'WAITING_FOR_INPUT',
  'RATE_LIMITED',
  'CAPACITY_LIMITED',
  'CONTEXT_EXHAUSTED',
  'AUTH_REQUIRED',
  'NETWORK_ERROR',
  'CRASHED',
  'COMPLETED',
  'FAILED',
  'STOPPED',
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export const TERMINAL_AGENT_STATES: readonly AgentState[] = [
  'INSTALLATION_NOT_FOUND',
  'RATE_LIMITED',
  'CAPACITY_LIMITED',
  'CONTEXT_EXHAUSTED',
  'AUTH_REQUIRED',
  'NETWORK_ERROR',
  'CRASHED',
  'COMPLETED',
  'FAILED',
  'STOPPED',
];

/** How the recovery engine should treat a terminal agent state. */
export type RecoveryClass = 'success' | 'limit' | 'context' | 'crash' | 'auth' | 'transient' | 'fatal' | 'stopped';

export function classifyAgentOutcome(state: AgentState): RecoveryClass {
  switch (state) {
    case 'COMPLETED':
      return 'success';
    case 'RATE_LIMITED':
    case 'CAPACITY_LIMITED':
      return 'limit';
    case 'CONTEXT_EXHAUSTED':
      return 'context';
    case 'CRASHED':
      return 'crash';
    case 'AUTH_REQUIRED':
      return 'auth';
    case 'NETWORK_ERROR':
      return 'transient';
    case 'STOPPED':
      return 'stopped';
    default:
      return 'fatal';
  }
}
