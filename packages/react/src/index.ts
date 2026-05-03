import { createElement, useEffect, useMemo, useRef, type MutableRefObject, type ReactElement } from 'react';
import type { PlimContent, PlimDriver, Transaction } from '@plim/core';
import { type AgnosticEditor, type AsyncEventListener, attachContainer, deriveEditor } from '@plim/editor';

export interface AsyncEventListenerRegistration<Name extends string = string> {
  eventName: Name;
  listener: AsyncEventListener;
}

export function useAsyncEventListener<Name extends string>(
  eventName: Name,
  listener: AsyncEventListener<Name>
): AsyncEventListenerRegistration<Name> {
  const latest = useRef(listener);
  latest.current = listener;

  return useMemo(
    () => ({
      eventName,
      listener: ((event, state, ctx) => latest.current(event as Parameters<AsyncEventListener<Name>>[0], state, ctx)) as AsyncEventListener
    }),
    [eventName]
  );
}

export function useEditorHandle(): MutableRefObject<AgnosticEditor | null> {
  return useRef<AgnosticEditor | null>(null);
}

export interface PlimEditorProps {
  plim: PlimDriver;
  handle?: MutableRefObject<AgnosticEditor | null>;
  initialContent?: PlimContent;
  readonly?: boolean;
  autoFocus?: boolean;
  onTransaction?: (transaction: Transaction) => void;
  whenReady?: () => void;
  asyncEventListeners?: AsyncEventListenerRegistration[];
  className?: string;
}

export function PlimEditor({
  plim,
  handle,
  initialContent,
  readonly = false,
  autoFocus = false,
  onTransaction,
  whenReady,
  asyncEventListeners = [],
  className
}: PlimEditorProps): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<AgnosticEditor | null>(null);

  useEffect(() => {
    if (!rootRef.current) {
      return undefined;
    }

    const editor = deriveEditor(plim, {
      containerAdapter: attachContainer(() => rootRef.current),
      ...(initialContent ? { initialContent } : {}),
      readonly,
      autoFocus
    });
    editorRef.current = editor;
    if (handle) {
      handle.current = editor;
    }

    const cleanup: Array<() => void> = [];
    if (onTransaction) {
      cleanup.push(editor.onTransaction(onTransaction));
    }
    if (whenReady) {
      cleanup.push(editor.whenReady(whenReady));
    }
    for (const registration of asyncEventListeners) {
      cleanup.push(editor.onAsyncEvent(registration.eventName, registration.listener));
    }

    return () => {
      for (const dispose of cleanup) {
        dispose();
      }
      editor.destroy();
      editorRef.current = null;
      if (handle) {
        handle.current = null;
      }
    };
  }, [plim, initialContent, readonly, autoFocus, onTransaction, whenReady, asyncEventListeners, handle]);

  return createElement('div', { ref: rootRef, className, 'data-plim-react-editor': 'true' });
}
