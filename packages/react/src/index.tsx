import * as React from 'react';
import type { ActionContext, EditorState, PlimDriver, Snapshot, Transaction } from '@plim/core';
import { type AgnosticEditor, attachContainer, deriveEditor } from '@plim/editor';

export type AsyncEventHandler<T = unknown> = (
	event: { name: string; payload?: unknown },
	state: EditorState,
	ctx: ActionContext
) => Promise<T> | T;

export type AsyncListenerRegistration = {
	__plimAsyncListener: true;
	name: string;
	handler: AsyncEventHandler;
};

export function useAsyncEventListener<T = unknown>(
	name: string,
	handler: AsyncEventHandler<T>
): AsyncListenerRegistration {
	const ref = React.useRef(handler);
	React.useEffect(() => {
		ref.current = handler;
	});
	const stable = React.useMemo<AsyncEventHandler>(
		() => (event, state, ctx) => ref.current(event, state, ctx),
		[]
	);
	return React.useMemo(
		() => ({ __plimAsyncListener: true as const, name, handler: stable }),
		[name, stable]
	);
}

export type EditorHandle = {
	get current(): AgnosticEditor | null;
	getEditor(): AgnosticEditor | null;
};

export function useEditorHandle(): EditorHandle {
	const ref = React.useRef<AgnosticEditor | null>(null);
	return React.useMemo<EditorHandle>(() => {
		const handle = {
			get current() {
				return ref.current;
			},
			getEditor() {
				return ref.current;
			},
			__set(e: AgnosticEditor | null) {
				ref.current = e;
			},
		};
		return handle as EditorHandle;
	}, []);
}

export type PlimEditorProps = {
	plim: PlimDriver;
	handle?: EditorHandle;
	initialContent?: import('@plim/core').DocumentNode;
	readonly?: boolean;
	autoFocus?: boolean;
	onTransaction?: (tx: Transaction, state: EditorState) => void;
	whenReady?: () => void;
	asyncEventListeners?: AsyncListenerRegistration[];
	className?: string;
	style?: React.CSSProperties;
};

export function PlimEditor(props: PlimEditorProps): React.ReactElement {
	const containerRef = React.useRef<HTMLDivElement | null>(null);
	const editorRef = React.useRef<AgnosticEditor | null>(null);

	React.useEffect(() => {
		if (!containerRef.current) return;
		const editor = deriveEditor(props.plim, {
			containerAdapter: attachContainer(() => containerRef.current),
			...(props.initialContent ? { initialContent: props.initialContent } : {}),
			readonly: props.readonly ?? false,
			autoFocus: props.autoFocus ?? false,
		});
		editorRef.current = editor;
		if (props.handle) (props.handle as unknown as { __set: (e: AgnosticEditor | null) => void }).__set(editor);
		const offTx = props.onTransaction ? editor.onTransaction(props.onTransaction) : undefined;
		const offReady = props.whenReady ? (editor.whenReady(props.whenReady), undefined) : undefined;
		const offs: Array<() => void> = [];
		for (const reg of props.asyncEventListeners ?? []) {
			offs.push(editor.onAsyncEvent(reg.name, reg.handler));
		}
		return () => {
			offTx?.();
			void offReady;
			for (const off of offs) off();
			editor.destroy();
			editorRef.current = null;
			if (props.handle) (props.handle as unknown as { __set: (e: AgnosticEditor | null) => void }).__set(null);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.plim]);

	// Keep readonly in sync without remounting
	React.useEffect(() => {
		const view = editorRef.current?.view;
		if (!view) return;
		view.root.setAttribute('contenteditable', props.readonly ? 'false' : 'true');
	}, [props.readonly]);

	return <div ref={containerRef} className={props.className} style={props.style} />;
}

export { type AgnosticEditor, type Snapshot };
