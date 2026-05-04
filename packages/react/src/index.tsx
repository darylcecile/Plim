import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ActionContext, BlockDescriptor, BlockPayload, EditorState, PlimDriver, Snapshot, Transaction } from '@plim/core';
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
		// Track React roots mounted into custom-block hosts. Keyed by the
		// host element itself so we can detect removed blocks via
		// `host.isConnected` after each transaction and unmount their roots
		// to prevent leaks. The view re-uses block wrappers across renders
		// but creates a fresh host element on every render of a custom
		// block, so we also unmount roots whose host has been replaced.
		const roots = new Map<HTMLElement, Root>();
		const renderReactBlock = (host: HTMLElement, payload: BlockPayload, desc: BlockDescriptor) => {
			let root = roots.get(host);
			if (!root) {
				root = createRoot(host);
				roots.set(host, root);
			}
			const node = desc.toComponent?.(payload) as React.ReactNode;
			root.render(<>{node}</>);
		};
		const editor = deriveEditor(props.plim, {
			containerAdapter: attachContainer(() => containerRef.current),
			...(props.initialContent ? { initialContent: props.initialContent } : {}),
			readonly: props.readonly ?? false,
			autoFocus: props.autoFocus ?? false,
			renderReactBlock,
		});
		editorRef.current = editor;
		if (props.handle) (props.handle as unknown as { __set: (e: AgnosticEditor | null) => void }).__set(editor);
		const offTx = props.onTransaction ? editor.onTransaction(props.onTransaction) : undefined;
		const offReady = props.whenReady ? (editor.whenReady(props.whenReady), undefined) : undefined;
		// Reap roots whose host is no longer in the DOM after each tx. Run
		// the reap on a microtask so the view's update has settled and any
		// re-rendered hosts have been re-attached. Unmount must be deferred
		// out of React's render cycle to avoid the "synchronously unmount
		// during render" warning.
		const offReap = editor.onTransaction(() => {
			queueMicrotask(() => {
				for (const [host, root] of roots) {
					if (!host.isConnected) {
						root.unmount();
						roots.delete(host);
					}
				}
			});
		});
		const offs: Array<() => void> = [];
		for (const reg of props.asyncEventListeners ?? []) {
			offs.push(editor.onAsyncEvent(reg.name, reg.handler));
		}
		return () => {
			offTx?.();
			offReap();
			void offReady;
			for (const off of offs) off();
			editor.destroy();
			// Unmount any remaining roots. Defer to a microtask for the same
			// reason as above (createRoot's unmount cannot run synchronously
			// inside another React commit).
			const pending = Array.from(roots.values());
			roots.clear();
			queueMicrotask(() => {
				for (const r of pending) r.unmount();
			});
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

// ──────────────────────────────────────────────────────────────────────────────
// <ActionPanel /> & <HoverMenu />
//
// Floating UI primitives positioned relative to a moving anchor (a DOM element,
// a DOMRect, or a function returning either). They re-measure on scroll and
// resize so the panel stays glued to its trigger. ActionPanel flips above the
// anchor when there isn't room below, and clamps horizontally to the viewport
// (or to a `boundary` element when supplied — typically the editor container).

export type ActionPanelAnchor =
	| Element
	| DOMRect
	| { x: number; y: number; width?: number; height?: number }
	| (() => Element | DOMRect | { x: number; y: number; width?: number; height?: number } | null | undefined);

export type ActionPanelProps = {
	/** Anchor for the panel: an element, a rect, or a function that returns one. */
	anchor: ActionPanelAnchor;
	/** Open state. When false, the panel is not rendered. */
	open?: boolean;
	/** Called when the user requests dismissal (Escape, outside click, scroll-out). */
	onClose?: () => void;
	/** Where to place the panel relative to the anchor. Default: 'bottom-start'. */
	placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
	/** Pixel offset between the anchor and the panel. Default: 4. */
	offset?: number;
	/** Optional element used to clamp the panel position (e.g. the editor container). */
	boundary?: Element | null;
	/** Close on outside pointerdown. Default: true. */
	dismissOnOutsideClick?: boolean;
	/** Close on Escape. Default: true. */
	dismissOnEscape?: boolean;
	className?: string;
	style?: React.CSSProperties;
	children?: React.ReactNode;
};

function rectFromAnchor(a: ActionPanelAnchor): DOMRect | null {
	const v = typeof a === 'function' ? a() : a;
	if (!v) return null;
	if (typeof Element !== 'undefined' && v instanceof Element) return v.getBoundingClientRect();
	if ('toJSON' in v && typeof (v as DOMRect).toJSON === 'function') return v as DOMRect;
	const r = v as { x: number; y: number; width?: number; height?: number };
	const w = r.width ?? 0;
	const h = r.height ?? 0;
	return new DOMRect(r.x, r.y, w, h);
}

export function ActionPanel(props: ActionPanelProps): React.ReactElement | null {
	const {
		anchor,
		open = true,
		onClose,
		placement = 'bottom-start',
		offset = 4,
		boundary = null,
		dismissOnOutsideClick = true,
		dismissOnEscape = true,
		className,
		style,
		children,
	} = props;

	const ref = React.useRef<HTMLDivElement | null>(null);
	const [pos, setPos] = React.useState<{ left: number; top: number; visibility: 'hidden' | 'visible' }>({
		left: 0,
		top: 0,
		visibility: 'hidden',
	});

	const anchorRef = React.useRef(anchor);
	anchorRef.current = anchor;
	const placementRef = React.useRef(placement);
	placementRef.current = placement;
	const offsetRef = React.useRef(offset);
	offsetRef.current = offset;
	const boundaryRef = React.useRef(boundary);
	boundaryRef.current = boundary;

	const reposition = React.useCallback(() => {
		const el = ref.current;
		if (!el) return;
		const rect = rectFromAnchor(anchorRef.current);
		if (!rect) return;
		const panelW = el.offsetWidth || 0;
		const panelH = el.offsetHeight || 0;
		const place = placementRef.current;
		const off = offsetRef.current;

		let top: number;
		if (place.startsWith('bottom')) {
			top = rect.bottom + off;
			if (top + panelH > window.innerHeight && rect.top - off - panelH >= 0) {
				top = rect.top - off - panelH;
			}
		} else {
			top = rect.top - off - panelH;
			if (top < 0 && rect.bottom + off + panelH <= window.innerHeight) {
				top = rect.bottom + off;
			}
		}

		let left: number;
		if (place.endsWith('end')) {
			left = rect.right - panelW;
		} else {
			left = rect.left;
		}

		const bRect = boundaryRef.current?.getBoundingClientRect();
		const minX = bRect ? bRect.left : 0;
		const maxX = bRect ? bRect.right : window.innerWidth;
		if (left + panelW > maxX) left = maxX - panelW;
		if (left < minX) left = minX;
		const minY = 0;
		const maxY = window.innerHeight;
		if (top + panelH > maxY) top = maxY - panelH;
		if (top < minY) top = minY;

		setPos({ left, top, visibility: 'visible' });
	}, []);

	// Reposition on every render-after-open and on scroll/resize/viewport changes.
	React.useLayoutEffect(() => {
		if (!open) return;
		reposition();
		const onScroll = () => reposition();
		const onResize = () => reposition();
		window.addEventListener('scroll', onScroll, true); // capture: catch scrolls on any ancestor
		window.addEventListener('resize', onResize);
		const ro =
			typeof ResizeObserver !== 'undefined' && ref.current ? new ResizeObserver(() => reposition()) : null;
		if (ro && ref.current) ro.observe(ref.current);
		return () => {
			window.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('resize', onResize);
			ro?.disconnect();
		};
	}, [open, reposition]);

	// Outside-click and Escape handlers.
	React.useEffect(() => {
		if (!open) return;
		const onPointer = (e: PointerEvent) => {
			if (!dismissOnOutsideClick) return;
			const target = e.target;
			if (target instanceof Node && ref.current && ref.current.contains(target)) return;
			onClose?.();
		};
		const onKey = (e: KeyboardEvent) => {
			if (!dismissOnEscape) return;
			if (e.key === 'Escape') {
				e.stopPropagation();
				onClose?.();
			}
		};
		window.addEventListener('pointerdown', onPointer, true);
		window.addEventListener('keydown', onKey, true);
		return () => {
			window.removeEventListener('pointerdown', onPointer, true);
			window.removeEventListener('keydown', onKey, true);
		};
	}, [open, dismissOnOutsideClick, dismissOnEscape, onClose]);

	if (!open) return null;
	return (
		<div
			ref={ref}
			className={className}
			style={{
				position: 'fixed',
				left: pos.left,
				top: pos.top,
				visibility: pos.visibility,
				zIndex: 1000,
				...style,
			}}
		>
			{children}
		</div>
	);
}

/**
 * <HoverMenu /> — a thin wrapper around ActionPanel intended for transient
 * affordances like formatting toolbars that follow a selection or a hovered
 * block. Default placement is 'top-start' (above the anchor) and outside
 * clicks do not dismiss it (the parent is expected to drive open state).
 */
export type HoverMenuProps = Omit<ActionPanelProps, 'placement' | 'dismissOnOutsideClick'> & {
	placement?: ActionPanelProps['placement'];
	dismissOnOutsideClick?: boolean;
};

export function HoverMenu(props: HoverMenuProps): React.ReactElement | null {
	const { placement = 'top-start', dismissOnOutsideClick = false, ...rest } = props;
	return <ActionPanel placement={placement} dismissOnOutsideClick={dismissOnOutsideClick} {...rest} />;
}

export { type AgnosticEditor, type Snapshot };

// Mounts an editor-owned `[data-block-content]` element inside an editable
// React block's DOM tree. The view passes the slot element via
// `payload.content[0]`; the component renders `<ContentSlot el={payload.content[0]} />`
// wherever it wants the editable text to live. The slot is appended to a thin
// host span on every commit; if it's already a child the ref callback no-ops,
// so React reconciliation never fights the editor's in-place text updates.
// `display: contents` keeps the wrapper visually transparent so the slot
// inherits whatever block-level styling the consumer applies to its own
// chrome.
export function ContentSlot(props: { el: HTMLElement | undefined }): React.ReactElement {
	const { el } = props;
	const setRef = React.useCallback(
		(node: HTMLSpanElement | null) => {
			if (!node || !el) return;
			if (el.parentNode === node) return;
			node.appendChild(el);
		},
		[el],
	);
	return <span ref={setRef} style={{ display: 'contents' }} />;
}

export {
	slashCommandExtension,
	SlashCommandMenu,
	DEFAULT_SLASH_ITEMS,
	type SlashCommandItem,
	type SlashCommandMenuProps,
	type SlashCommandExtensionOptions,
	type SlashCommandApplyContext,
} from './extensions/slash-command.js';
export {
	mentionExtension,
	MentionMenu,
	DEFAULT_MENTION_USERS,
	type MentionUser,
	type MentionMenuProps,
	type MentionExtensionOptions,
} from './extensions/mention.js';
