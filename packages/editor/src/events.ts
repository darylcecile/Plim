import { EditorError } from './errors.js';
import type { EditorEvent } from './types.js';

type Handler<TEvent extends EditorEvent> = (event: TEvent) => void;

export class EditorEventEmitter {
  private readonly handlers = new Map<EditorEvent['type'], Set<Handler<EditorEvent>>>();
  private reporter: ((error: EditorError) => void) | undefined;

  setErrorReporter(reporter: ((error: EditorError) => void) | undefined): void {
    this.reporter = reporter;
  }

  on<TType extends EditorEvent['type']>(type: TType, handler: Handler<Extract<EditorEvent, { type: TType }>>): () => void {
    const existing = this.handlers.get(type) ?? new Set<Handler<EditorEvent>>();
    const cast = handler as Handler<EditorEvent>;
    existing.add(cast);
    this.handlers.set(type, existing);
    return () => {
      const current = this.handlers.get(type);
      current?.delete(cast);
      if (current?.size === 0) this.handlers.delete(type);
    };
  }

  emit<TEvent extends EditorEvent>(event: TEvent): void {
    const typedHandlers = [...(this.handlers.get(event.type) ?? [])];
    for (const handler of typedHandlers) {
      try {
        handler(event);
      } catch (cause) {
        const error = cause instanceof EditorError
          ? cause
          : new EditorError('adapter_failed', cause instanceof Error ? cause.message : 'Editor event handler failed', { cause });
        this.reporter?.(error);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
