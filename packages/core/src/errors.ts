import { redact } from './redact.js';

/** Stable machine-readable error codes. Extend, never repurpose. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_TRANSITION',
  'DEPENDENCY_CYCLE',
  'DEPENDENCY_MISSING',
  'LEASE_LOST',
  'RATE_LIMITED',
  'CONCURRENCY_LIMIT',
  'NO_ELIGIBLE_WORKER',
  'NO_COMPATIBLE_AGENT',
  'NO_COMPATIBLE_MODEL',
  'PATH_OUTSIDE_PROJECT',
  'UNSAFE_ARGUMENT',
  'GIT_POLICY_VIOLATION',
  'CAPABILITY_BLOCKED',
  'CAPABILITY_APPROVAL_REQUIRED',
  'PROVIDER_ERROR',
  'AGENT_ERROR',
  'INTERNAL',
  'MFA_REQUIRED',
  /** An external service the control plane called (e.g. GitHub) refused or failed. */
  'UPSTREAM_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNSAFE_ARGUMENT: 400,
  PATH_OUTSIDE_PROJECT: 400,
  DEPENDENCY_CYCLE: 400,
  DEPENDENCY_MISSING: 400,
  UNAUTHENTICATED: 401,
  MFA_REQUIRED: 401,
  FORBIDDEN: 403,
  CAPABILITY_BLOCKED: 403,
  GIT_POLICY_VIOLATION: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  LEASE_LOST: 409,
  CAPABILITY_APPROVAL_REQUIRED: 409,
  CONCURRENCY_LIMIT: 429,
  RATE_LIMITED: 429,
  NO_ELIGIBLE_WORKER: 503,
  NO_COMPATIBLE_AGENT: 422,
  NO_COMPATIBLE_MODEL: 422,
  UPSTREAM_ERROR: 502,
};

export interface AppErrorOptions {
  context?: Record<string, unknown>;
  correlationId?: string;
  retryable?: boolean;
  userMessage?: string;
  cause?: unknown;
}

/** Structured error (spec §112). Context is redacted on construction so secrets cannot leak. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly context: Record<string, unknown>;
  readonly correlationId?: string;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string, opts: AppErrorOptions = {}) {
    super(redact(message), opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.context = redact(opts.context ?? {});
    this.correlationId = opts.correlationId;
    this.retryable = opts.retryable ?? false;
    this.userMessage = opts.userMessage ?? this.message;
    this.httpStatus = HTTP_STATUS[code] ?? 500;
  }

  /** Safe serialisation for API responses — never includes stack or cause. */
  toJSON() {
    return {
      code: this.code,
      message: this.userMessage,
      context: this.context,
      correlationId: this.correlationId,
      retryable: this.retryable,
    };
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
