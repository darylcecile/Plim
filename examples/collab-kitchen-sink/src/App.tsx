import * as React from 'react';
import {
Collaborator,
PlimDriver,
boldMark,
codeMark,
defineAction,
headingBlock,
italicMark,
paragraphBlock,
triggers,
type DocumentNode,
type Peer,
type Selection,
type VersionVector,
} from '@plim/core';
import { PlimEditor, useEditorHandle } from '@plim/react';
import { COLLAB_PATH, COLLAB_PORT, makeBaseDoc } from './shared.js';
import { WebSocketTransport, type ConnectionStatus } from './ws-transport.js';

// ──────────────────────────────────────────────────────────────────────────────
// ONE editor, opened in many places. Each tab/window/browser/device that loads
// this page is a distinct `Collaborator` talking to the standalone Hono + ws
// server (see ../server/index.ts) over a real WebSocket. Type here and the edit
// applies optimistically, the server linearizes it into the canonical order, and
// every other open copy converges — caret held steady, remote cursors live.
// ──────────────────────────────────────────────────────────────────────────────

type EditorRef = NonNullable<ReturnType<ReturnType<typeof useEditorHandle>['getEditor']>>;

function makeDriver(): PlimDriver {
return new PlimDriver({
theme: 'light',
registeredMarks: [boldMark, italicMark, codeMark],
registeredBlocks: [paragraphBlock, headingBlock],
registeredActions: [
defineAction('bold', {
trigger: triggers.keyboard.shortcut('Mod+b'),
triggerValidationRules: ({ and }) => and(['selectionNotEmpty', 'blockSupportsDecoration']),
perform: async (state, ctx) => {
const tx = ctx.createTransaction();
tx.toggleMark('bold', { from: state.selection.anchor, to: state.selection.head });
tx.commit();
},
}),
defineAction('italic', {
trigger: triggers.keyboard.shortcut('Mod+i'),
triggerValidationRules: ({ and }) => and(['selectionNotEmpty', 'blockSupportsDecoration']),
perform: async (state, ctx) => {
const tx = ctx.createTransaction();
tx.toggleMark('italic', { from: state.selection.anchor, to: state.selection.head });
tx.commit();
},
}),
],
});
}

// ---- per-tab identity -------------------------------------------------------

const ADJECTIVES = ['Swift', 'Calm', 'Bright', 'Bold', 'Keen', 'Lucid', 'Nimble', 'Vivid', 'Warm', 'Brave'];
const ANIMALS = ['Otter', 'Falcon', 'Maple', 'Heron', 'Lynx', 'Wren', 'Koi', 'Fox', 'Sparrow', 'Ibis'];
const COLORS = ['#2563eb', '#d97706', '#15803d', '#7c3aed', '#db2777', '#0891b2', '#ca8a04', '#dc2626', '#4f46e5', '#0d9488'];

function pick<T>(arr: readonly T[]): T {
return arr[Math.floor(Math.random() * arr.length)]!;
}

// Identity is stored in sessionStorage: a reload keeps the same user, a brand
// new tab gets a fresh one — which is exactly what you want for a "who's here"
// demo across tabs.
function loadIdentity(): Peer {
const KEY = 'plim-collab-peer';
try {
const raw = sessionStorage.getItem(KEY);
if (raw) return JSON.parse(raw) as Peer;
} catch {
/* fall through to fresh identity */
}
const id = (globalThis.crypto?.randomUUID?.() ?? `peer-${Math.random().toString(36).slice(2)}`);
const peer: Peer = { id, name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(COLORS) };
try {
sessionStorage.setItem(KEY, JSON.stringify(peer));
} catch {
/* private mode: ephemeral identity is fine */
}
return peer;
}

// ---- selection helpers ------------------------------------------------------

function posLabel(sel: Selection | null | undefined): string {
if (!sel) return '—';
const h = sel.head;
const a = sel.anchor;
const at = `¶${(h.path[0] ?? 0) + 1}:${h.offset}`;
const collapsed = a.path.join(',') === h.path.join(',') && a.offset === h.offset;
return collapsed ? at : `¶${(a.path[0] ?? 0) + 1}:${a.offset}→${at}`;
}

function vvLabel(vv: VersionVector): string {
const entries = Object.entries(vv).filter(([k]) => k.length > 0);
if (entries.length === 0) return '∅';
return entries
.sort(([a], [b]) => (a < b ? -1 : 1))
.map(([k, n]) => `${k.slice(0, 4)}:${n}`)
.join('  ');
}

function cssEscape(value: string): string {
const c = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
return c?.escape ? c.escape(value) : value.replace(/["\\]/g, '\\$&');
}

// Map a (block, character-offset) position to a viewport rect by walking the
// block's rendered text nodes and collapsing a DOM Range there. Returns null if
// the position can't be resolved (block not in the DOM yet, nested path, …) so
// the caller can simply skip drawing that cursor.
function caretRectFor(root: HTMLElement, blockId: string, offset: number): DOMRect | null {
const blockEl = root.querySelector<HTMLElement>(`[data-block-id="${cssEscape(blockId)}"]`);
if (!blockEl) return null;
const content = blockEl.querySelector<HTMLElement>('[data-block-content]') ?? blockEl;
const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
let remaining = offset;
let last: Text | null = null;
for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
last = node;
if (remaining <= node.data.length) {
const range = document.createRange();
range.setStart(node, Math.max(0, remaining));
range.collapse(true);
return range.getBoundingClientRect();
}
remaining -= node.data.length;
}
if (last) {
const range = document.createRange();
range.setStart(last, last.data.length);
range.collapse(true);
return range.getBoundingClientRect();
}
return content.getBoundingClientRect();
}

interface CaretBox {
id: string;
name: string;
color: string;
top: number;
left: number;
height: number;
}

// ──────────────────────────────────────────────────────────────────────────────

export function App(): React.ReactElement {
const handle = useEditorHandle();
const driver = React.useMemo(() => makeDriver(), []);
const me = React.useMemo(() => loadIdentity(), []);
const initial = React.useMemo<DocumentNode>(() => makeBaseDoc(), []);

const collabRef = React.useRef<Collaborator | null>(null);
const wrapRef = React.useRef<HTMLDivElement | null>(null);
const caretSig = React.useRef('');

const [, force] = React.useReducer((n: number) => n + 1, 0);
const [status, setStatus] = React.useState<ConnectionStatus>('connecting');
const [carets, setCarets] = React.useState<CaretBox[]>([]);

// Recompute remote caret overlays from current presence + DOM geometry.
const recomputeCarets = React.useCallback(() => {
const collab = collabRef.current;
const wrap = wrapRef.current;
const ed = handle.getEditor();
if (!collab || !wrap || !ed) return;
const doc = ed.getState().doc;
const wrapRect = wrap.getBoundingClientRect();
const boxes: CaretBox[] = [];
for (const p of collab.peers) {
const sel = (p.state.selection as Selection | undefined) ?? null;
if (!sel || sel.head.path.length !== 1) continue;
const block = doc.children[sel.head.path[0] ?? -1];
if (!block) continue;
const rect = caretRectFor(wrap, block.id, sel.head.offset);
if (!rect) continue;
boxes.push({
id: p.peer.id,
name: p.peer.name ?? p.peer.id.slice(0, 6),
color: p.peer.color ?? '#6b7280',
top: rect.top - wrapRect.top,
left: rect.left - wrapRect.left,
height: rect.height || 20,
});
}
const sig = JSON.stringify(boxes);
if (sig !== caretSig.current) {
caretSig.current = sig;
setCarets(boxes);
}
}, [handle]);

const ready = React.useCallback(() => {
const ed = handle.getEditor();
if (!ed) return;
collabRef.current?.destroy();
const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:${COLLAB_PORT}${COLLAB_PATH}`;
const transport = new WebSocketTransport({ url, onStatus: setStatus });
const collab = new Collaborator({ peer: me, editor: ed, transport });
collab.setPresence({ name: me.name, color: me.color, selection: ed.getState().selection });
collab.onChange(() => force());
collabRef.current = collab;
force();
}, [handle, me]);

React.useEffect(() => {
return () => {
collabRef.current?.destroy();
collabRef.current = null;
};
}, []);

// Redraw remote carets after every render (presence/edits bump `force`) and on
// scroll/resize. The compare-by-signature inside keeps this from looping.
React.useLayoutEffect(() => {
recomputeCarets();
});
React.useEffect(() => {
const onMove = () => recomputeCarets();
window.addEventListener('scroll', onMove, true);
window.addEventListener('resize', onMove);
return () => {
window.removeEventListener('scroll', onMove, true);
window.removeEventListener('resize', onMove);
};
}, [recomputeCarets]);

const collab = collabRef.current;
const cs = collab?.status;
const selfSel = collab ? handle.getEditor()?.getState().selection ?? null : null;
const remote = collab?.peers ?? [];

return (
<div className="page">
<header className="hero">
<div className="hero-row">
<h1>Collaborative editor</h1>
<ConnectionPill status={status} />
</div>
<p>
This is a single document served over a real WebSocket by a tiny{' '}
<code>Hono</code> backend wrapping <code>CollabHub</code> from <code>@plim/core</code>. Open this URL in another
tab, window, browser, or device on your network and edit together — live.
</p>
<div className="you">
<span className="dot" style={{ background: me.color }} />
You are <strong>{me.name}</strong>
<span className="muted"> · {remote.length} other{remote.length === 1 ? '' : 's'} here</span>
</div>
</header>

<div className="editor-wrap" ref={wrapRef}>
<PlimEditor plim={driver} handle={handle} initialContent={initial} autoFocus className="editor" whenReady={ready} />
<div className="caret-layer" aria-hidden>
{carets.map((c) => (
<div key={c.id} className="remote-caret" style={{ top: c.top, left: c.left, height: c.height, background: c.color }}>
<span className="remote-flag" style={{ background: c.color }}>
{c.name}
</span>
</div>
))}
</div>
</div>

<section className="inspectors">
<Roster self={me} selfSel={selfSel} remote={remote} />
<SyncPanel status={status} head={cs?.head ?? 0} pending={cs?.pending ?? 0} inflight={cs?.inflight ?? false} vv={collab?.versionVector() ?? {}} />
</section>

<footer className="foot">
<span>
⌘/Ctrl+B bold · ⌘/Ctrl+I italic. Edits are optimistic locally and linearized by the server into one canonical
order, so every open copy converges. Restarting the server resets the shared doc.
</span>
</footer>
</div>
);
}

// ──────────────────────────────────────────────────────────────────────────────

function ConnectionPill(props: { status: ConnectionStatus }): React.ReactElement {
const label = props.status === 'online' ? 'connected' : props.status === 'connecting' ? 'connecting…' : 'offline · retrying';
return <span className={`conn conn-${props.status}`}>{label}</span>;
}

function Roster(props: { self: Peer; selfSel: Selection | null; remote: ReadonlyArray<{ peer: Peer; state: { selection?: Selection | null } }> }): React.ReactElement {
return (
<div className="panel">
<h2>Who’s here</h2>
<ul className="roster">
<li>
<span className="who">
<span className="dot" style={{ background: props.self.color ?? '#888' }} /> {props.self.name} <span className="tag">you</span>
</span>
<span className="caret">{posLabel(props.selfSel)}</span>
</li>
{props.remote.map((p) => (
<li key={p.peer.id}>
<span className="who">
<span className="dot" style={{ background: p.peer.color ?? '#888' }} /> {p.peer.name ?? p.peer.id.slice(0, 8)}
</span>
<span className="caret">{posLabel(p.state.selection ?? null)}</span>
</li>
))}
</ul>
{props.remote.length === 0 && <p className="empty">No one else yet. Open this page in another tab to see them appear.</p>}
</div>
);
}

function SyncPanel(props: { status: ConnectionStatus; head: number; pending: number; inflight: boolean; vv: VersionVector }): React.ReactElement {
return (
<div className="panel">
<h2>Sync state</h2>
<dl className="sync">
<div>
<dt>connection</dt>
<dd className={`mono conn-text conn-${props.status}`}>{props.status}</dd>
</div>
<div>
<dt>canonical version</dt>
<dd className="mono">
<strong>{props.head}</strong>
</dd>
</div>
<div>
<dt>pending (optimistic)</dt>
<dd className="mono">
{props.pending}
{props.inflight ? ' · ⇡ in flight' : ''}
</dd>
</div>
<div>
<dt>version vector</dt>
<dd className="mono">{vvLabel(props.vv)}</dd>
</div>
</dl>
<p className="hint">
Local edits sit in <code>pending</code> until the server confirms them; <code>canonical version</code> is the count of
confirmed records every peer agrees on. At rest, pending drains to 0 everywhere.
</p>
</div>
);
}
