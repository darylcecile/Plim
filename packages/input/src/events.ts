import type { KeyboardEventLike } from './shortcuts.js';

export interface CompositionEventLike {
  type?: string;
  data?: string;
}

export interface InputEventLike {
  inputType: string;
  data?: string | null;
  isComposing?: boolean;
  dataTransfer?: unknown;
  getTargetRanges?: () => readonly unknown[];
}

export type BeforeInputKind =
  | 'insert_text'
  | 'insert_line_break'
  | 'insert_paragraph'
  | 'delete_backward'
  | 'delete_forward'
  | 'paste'
  | 'drop'
  | 'format'
  | 'history_undo'
  | 'history_redo'
  | 'unknown';

export interface BeforeInputClassification {
  kind: BeforeInputKind;
  inputType: string;
  data: string;
  hasDataTransfer: boolean;
  targetRangeCount: number;
  composing: boolean;
}

export class CompositionGuard {
  #depth = 0;
  #lastData = '';

  get composing(): boolean {
    return this.#depth > 0;
  }

  get lastData(): string {
    return this.#lastData;
  }

  start(event?: CompositionEventLike): void {
    this.#depth = 1;
    this.#lastData = event?.data ?? '';
  }

  update(event?: CompositionEventLike): void {
    if (this.#depth <= 0) this.#depth = 1;
    this.#lastData = event?.data ?? this.#lastData;
  }

  end(event?: CompositionEventLike): string {
    this.#lastData = event?.data ?? this.#lastData;
    this.#depth = 0;
    return this.#lastData;
  }

  cancel(): void {
    this.#depth = 0;
    this.#lastData = '';
  }
}

export function isComposingEvent(event: { isComposing?: boolean } | null | undefined, guard?: CompositionGuard): boolean {
  return Boolean(event?.isComposing) || Boolean(guard?.composing);
}

export function shouldIgnorePrintableShortcut(event: KeyboardEventLike, guard?: CompositionGuard): boolean {
  if (isComposingEvent(event, guard)) return true;
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
}

export function shouldRunInputRules(event: InputEventLike, guard?: CompositionGuard): boolean {
  if (isComposingEvent(event, guard)) return false;
  const kind = classifyBeforeInput(event).kind;
  return kind === 'insert_text' || kind === 'insert_paragraph' || kind === 'insert_line_break';
}

export function shouldOpenInlineAutocomplete(event: InputEventLike, guard?: CompositionGuard): boolean {
  if (isComposingEvent(event, guard)) return false;
  const classification = classifyBeforeInput(event);
  return classification.kind === 'insert_text' && ['@', '[', '+', '/', ':'].includes(classification.data);
}

export function classifyBeforeInput(event: InputEventLike): BeforeInputClassification {
  const inputType = event.inputType;
  const data = event.data ?? '';
  return {
    kind: kindForInputType(inputType),
    inputType,
    data,
    hasDataTransfer: event.dataTransfer !== undefined && event.dataTransfer !== null,
    targetRangeCount: targetRangeCount(event),
    composing: Boolean(event.isComposing)
  };
}

export function shouldPreventNativeBeforeInput(classification: BeforeInputClassification): boolean {
  return classification.kind === 'paste'
    || classification.kind === 'drop'
    || classification.kind === 'history_undo'
    || classification.kind === 'history_redo';
}

export function isDeletionInput(kind: BeforeInputKind): boolean {
  return kind === 'delete_backward' || kind === 'delete_forward';
}

export function isHistoryInput(kind: BeforeInputKind): boolean {
  return kind === 'history_undo' || kind === 'history_redo';
}

function kindForInputType(inputType: string): BeforeInputKind {
  if (inputType === 'insertText' || inputType === 'insertCompositionText') return 'insert_text';
  if (inputType === 'insertLineBreak') return 'insert_line_break';
  if (inputType === 'insertParagraph') return 'insert_paragraph';
  if (inputType === 'deleteContentBackward' || inputType === 'deleteWordBackward' || inputType === 'deleteByCut') return 'delete_backward';
  if (inputType === 'deleteContentForward' || inputType === 'deleteWordForward') return 'delete_forward';
  if (inputType === 'insertFromPaste' || inputType === 'insertFromPasteAsQuotation') return 'paste';
  if (inputType === 'insertFromDrop') return 'drop';
  if (inputType.startsWith('format')) return 'format';
  if (inputType === 'historyUndo') return 'history_undo';
  if (inputType === 'historyRedo') return 'history_redo';
  return 'unknown';
}

function targetRangeCount(event: InputEventLike): number {
  try {
    return event.getTargetRanges?.().length ?? 0;
  } catch {
    return 0;
  }
}
