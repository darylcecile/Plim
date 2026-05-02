import type { ValidationIssue } from '@plim/model';

export type EditorErrorCode =
  | 'editor_destroyed'
  | 'already_mounted'
  | 'not_mounted'
  | 'invalid_host'
  | 'read_only'
  | 'command_not_found'
  | 'command_disabled'
  | 'command_failed'
  | 'transaction_rejected'
  | 'validation_failed'
  | 'normalization_failed'
  | 'normalization_loop'
  | 'persistence_failed'
  | 'plugin_failed'
  | 'renderer_failed'
  | 'controlled_pending'
  | 'transaction_not_found'
  | 'invalid_snapshot'
  | 'invalid_document'
  | 'adapter_failed';

export interface EditorErrorOptions {
  cause?: unknown;
  issues?: ValidationIssue[];
  details?: Record<string, unknown>;
}

export class EditorError extends Error {
  readonly code: EditorErrorCode;
  readonly issues: readonly ValidationIssue[];
  readonly details: Readonly<Record<string, unknown>>;
  override readonly cause?: unknown;

  constructor(code: EditorErrorCode, message: string, options: EditorErrorOptions = {}) {
    super(message);
    this.name = 'EditorError';
    this.code = code;
    this.issues = options.issues ?? [];
    this.details = Object.freeze({ ...(options.details ?? {}) });
    if ('cause' in options) this.cause = options.cause;
  }
}

export class EditorDestroyedError extends EditorError {
  constructor() {
    super('editor_destroyed', 'Editor has been destroyed');
    this.name = 'EditorDestroyedError';
  }
}

export class TransactionRejectedError extends EditorError {
  constructor(message: string, options: EditorErrorOptions = {}) {
    super('transaction_rejected', message, options);
    this.name = 'TransactionRejectedError';
  }
}

export function toEditorError(code: EditorErrorCode, message: string, cause: unknown): EditorError {
  if (cause instanceof EditorError) return cause;
  return new EditorError(code, cause instanceof Error ? cause.message : message, { cause });
}
