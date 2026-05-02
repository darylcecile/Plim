import { MODEL_FORMAT, MODEL_VERSION } from './factory.js';
import { normalizeDocumentState, validateDocumentState } from './validation.js';
import { isRecord, sortJsonValue } from './utils.js';
import type { DocumentState, SerializedDocumentV1, ValidationIssue } from './types.js';

export interface DeserializeResult {
  ok: boolean;
  state?: DocumentState;
  issues: ValidationIssue[];
}

export function serializeDocument(state: DocumentState, options: { normalize?: boolean } = {}): SerializedDocumentV1 {
  const normalizedState = options.normalize === false ? state : normalizeDocumentState(state);
  return {
    object: 'notion_next_document',
    schema: normalizedState.schema,
    state: normalizedState
  };
}

export function deserializeDocument(input: unknown): DeserializeResult {
  if (!isSerializedDocumentV1(input)) {
    return {
      ok: false,
      issues: [{
        severity: 'error',
        code: 'schema_mismatch',
        message: 'Input is not a SerializedDocumentV1 envelope',
        path: '',
        fix: 'none'
      }]
    };
  }

  const result = validateDocumentState(input.state, { normalize: true });
  return {
    ok: result.ok,
    issues: result.issues,
    ...(result.normalized ? { state: result.normalized } : {})
  };
}

export function stringifyDocument(stateOrEnvelope: DocumentState | SerializedDocumentV1, space: number = 2): string {
  const envelope = isSerializedDocumentV1(stateOrEnvelope)
    ? stateOrEnvelope
    : serializeDocument(stateOrEnvelope);
  return JSON.stringify(sortJsonValue(envelope), null, space);
}

export function parseDocumentJson(json: string): DeserializeResult {
  try {
    return deserializeDocument(JSON.parse(json) as unknown);
  } catch (error) {
    return {
      ok: false,
      issues: [{
        severity: 'error',
        code: 'schema_mismatch',
        message: error instanceof Error ? error.message : 'Invalid JSON',
        path: '',
        fix: 'none'
      }]
    };
  }
}

export function isSerializedDocumentV1(value: unknown): value is SerializedDocumentV1 {
  return isRecord(value)
    && value.object === 'notion_next_document'
    && isRecord(value.schema)
    && value.schema.format === MODEL_FORMAT
    && value.schema.version === MODEL_VERSION
    && isRecord(value.state);
}
