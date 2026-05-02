import { cloneDeep } from '@plim/model';
import type { DocumentState, TransactionRecord } from '@plim/model';
import type { EditorSelection, EditorSnapshot, EditorState, EditorStatus } from './types.js';

export function createEditorState(input: {
  version: number;
  document: DocumentState;
  selection: EditorSelection | null;
  status: EditorStatus;
  dirty: boolean;
  pendingTransactions?: readonly TransactionRecord[];
}): EditorState {
  return deepFreeze({
    version: input.version,
    document: input.document,
    selection: input.selection,
    status: input.status,
    dirty: input.dirty,
    pendingTransactions: [...(input.pendingTransactions ?? [])]
  });
}

export function createSnapshot(state: EditorState, generatedAt: string, persistenceKey?: string): EditorSnapshot {
  const base = {
    object: 'plim_editor_snapshot' as const,
    version: state.version,
    document: cloneDeep(state.document) as DocumentState,
    selection: cloneDeep(state.selection) as EditorSelection | null,
    pendingTransactions: cloneDeep(state.pendingTransactions) as TransactionRecord[],
    dirty: state.dirty,
    generatedAt
  };
  if (persistenceKey === undefined) return deepFreeze(base);
  return deepFreeze({ ...base, persistenceKey });
}

export function snapshotDocument(input: DocumentState | EditorSnapshot): DocumentState {
  if (isEditorSnapshot(input)) return cloneDeep(input.document) as DocumentState;
  return cloneDeep(input) as DocumentState;
}

export function snapshotSelection(input: DocumentState | EditorSnapshot): EditorSelection | null {
  return isEditorSnapshot(input) ? cloneDeep(input.selection) as EditorSelection | null : null;
}

export function isEditorSnapshot(value: unknown): value is EditorSnapshot {
  return typeof value === 'object'
    && value !== null
    && (value as { object?: unknown }).object === 'plim_editor_snapshot'
    && typeof (value as { version?: unknown }).version === 'number'
    && typeof (value as { generatedAt?: unknown }).generatedAt === 'string'
    && typeof (value as { document?: unknown }).document === 'object';
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const objectValue = value as Record<PropertyKey, unknown>;
  if (Object.isFrozen(objectValue)) return value;
  Object.freeze(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    const child = objectValue[key];
    if (child !== null && typeof child === 'object') deepFreeze(child);
  }
  return value;
}
