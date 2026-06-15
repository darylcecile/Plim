import * as React from 'react';
import {
	Collaborator,
	PlimDriver,
	boldMark,
	codeMark,
	createMemoryNetwork,
	defineAction,
	headingBlock,
	italicMark,
	paragraphBlock,
	triggers,
	type BlockNode,
	type DocumentNode,
	type MemoryNetwork,
	type Peer,
	type Selection,
	type VersionVector,
} from '@plim/core';
import { PlimEditor, useEditorHandle } from '@plim/react';

// ──────────────────────────────────────────────────────────────────────────────
// A single in-process network (one embedded authority + loopback transports)
// stands in for "the server". Every pane below is a real, independent Plim
// editor wrapped in a `Collaborator` that talks to this hub. Type in any pane
// and the edit flows optimistically locally, gets linearized by the authority,
// then converges on every other pane — exactly the path a production websocket
// transport would take, minus the socket.
// ──────────────────────────────────────────────────────────────────────────────

type EditorRef = NonNullable<ReturnType<ReturnType<typeof useEditorHandle>['getEditor']>>;

const PEERS = {
	alice: { id: 'alice', name: 'Alice', color: '#2563eb' },
	bob: { id: 'bob', name: 'Bob', color: '#d97706' },
	carol: { id: 'carol', name: 'Carol', color: '#15803d' },
	dave: { id: 'dave', name: 'Dave', color: '#7c3aed' },
} satisfies Record<string, Peer>;

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

// The shared origin every peer (and the authority) replays the canonical log onto.
function makeBase(): DocumentNode {
	return {
		type: 'doc',
		children: [
			{ id: 'h', type: 'heading', attrs: { level: 2 }, text: [{ text: 'Live collaborative document' }] },
			{ id: 'p1', type: 'paragraph', text: [{ text: 'The quick brown fox jumps over the lazy dog.' }] },
			{ id: 'p2', type: 'paragraph', text: [{ text: 'Type in any pane — edits sync through the authority and converge everywhere.' }] },
		],
	};
}

function clone<T>(v: T): T {
	return JSON.parse(JSON.stringify(v)) as T;
}

function blockText(b: BlockNode): string {
	const own = (b.text ?? []).map((t) => t.text).join('');
	const kids = (b.children ?? []).map(blockText).join(' ');
	return [own, kids].filter(Boolean).join(' ');
}

function posLabel(sel: Selection | null | undefined): string {
	if (!sel) return '—';
	const a = sel.anchor;
	const h = sel.head;
	const at = `¶${h.path[0] ?? 0}:${h.offset}`;
	const collapsed = a.path.join(',') === h.path.join(',') && a.offset === h.offset;
	return collapsed ? at : `¶${a.path[0] ?? 0}:${a.offset}→${at}`;
}

function vvLabel(vv: VersionVector): string {
	const entries = Object.entries(vv);
	if (entries.length === 0) return '∅';
	return entries
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([k, n]) => `${k.slice(0, 1).toUpperCase()}${k.slice(1, 3)}:${n}`)
		.join('  ');
}

// ──────────────────────────────────────────────────────────────────────────────

interface Registered {
	collab: Collaborator;
	editor: EditorRef;
}

export function App(): React.ReactElement {
	const base = React.useMemo(() => makeBase(), []);
	const latencyRef = React.useRef(120);
	const [latency, setLatency] = React.useState(120);
	const net = React.useMemo<MemoryNetwork>(() => createMemoryNetwork({ origin: base, latencyMs: () => latencyRef.current }), [base]);

	const registry = React.useRef(new Map<string, Registered>());
	const [, force] = React.useReducer((n: number) => n + 1, 0);
	const [daveJoined, setDaveJoined] = React.useState(false);

	const register = React.useCallback((id: string, collab: Collaborator, editor: EditorRef) => {
		registry.current.set(id, { collab, editor });
		force();
	}, []);
	const unregister = React.useCallback((id: string) => {
		registry.current.delete(id);
		force();
	}, []);

	const onLatency = (ms: number) => {
		latencyRef.current = ms;
		setLatency(ms);
	};

	// Fire three concurrent inserts at the SAME position from three peers in one
	// tick. With latency > 0 none has confirmed before the others author, so the
	// authority must linearize them — the classic OT convergence stress.
	const burst = () => {
		const targets = ['alice', 'bob', 'carol'] as const;
		const tokens: Record<string, string> = { alice: '«A» ', bob: '«B» ', carol: '«C» ' };
		for (const id of targets) {
			const entry = registry.current.get(id);
			if (!entry) continue;
			const tx = entry.editor.createTransaction();
			tx.insertText([1], 0, tokens[id]!);
			tx.commit();
		}
		force();
	};

	const heading = () => {
		const entry = registry.current.get('alice');
		if (!entry) return;
		const tx = entry.editor.createTransaction();
		tx.setBlockType([2], 'heading');
		tx.commit();
		force();
	};

	const authorityDoc = net.authority.doc;
	const live = [...registry.current.values()];
	const allConfirmedMatch = live.length > 0 && live.every((r) => JSON.stringify(r.collab.confirmedDocument) === JSON.stringify(authorityDoc));
	const anyPending = live.some((r) => r.collab.status.pending > 0);
	const converged = allConfirmedMatch && !anyPending;

	return (
		<div className="page">
			<header className="hero">
				<h1>Collaboration kitchen sink</h1>
				<p>
					Three editors share one document through an in-process <code>createMemoryNetwork()</code> hub. Each pane is a real{' '}
					<code>Collaborator</code> from <code>@plim/core</code>: local edits apply optimistically, the authority linearizes
					them into one canonical order, and every peer converges — caret position preserved, never stolen.
				</p>
				<div className="toolbar">
					<button className="primary" onClick={burst}>
						⚡ Concurrent burst (A · B · C at same spot)
					</button>
					<button onClick={heading}>Make ¶3 a heading (Alice)</button>
					<label className="strategy">
						latency
						<input
							type="range"
							min={0}
							max={500}
							step={20}
							value={latency}
							onChange={(e) => onLatency(Number(e.target.value))}
						/>
						<span className="badge">{latency}ms</span>
					</label>
					{!daveJoined ? (
						<button onClick={() => setDaveJoined(true)}>＋ Dave joins late (delta sync)</button>
					) : (
						<button onClick={() => setDaveJoined(false)}>Dave leaves</button>
					)}
					<button className="ghost" onClick={() => window.location.reload()}>
						Reset
					</button>
				</div>
				<p className="hint">
					Click into any editor and type (⌘/Ctrl+B, ⌘/Ctrl+I for marks). Raise the latency to watch the optimistic UI lead
					the confirmed state. Convergence:{' '}
					{converged ? (
						<strong className="ok">✓ all peers match the authority</strong>
					) : (
						<strong className="danger">… in flight ({live.reduce((n, r) => n + r.collab.status.pending, 0)} pending)</strong>
					)}
					.
				</p>
			</header>

			<section className="grid grid-3">
				<CollabPane peer={PEERS.alice} accent="a" base={base} net={net} register={register} unregister={unregister} onChange={force} autoFocus />
				<CollabPane peer={PEERS.bob} accent="b" base={base} net={net} register={register} unregister={unregister} onChange={force} />
				<CollabPane peer={PEERS.carol} accent="c" base={base} net={net} register={register} unregister={unregister} onChange={force} />
			</section>

			<section className="inspectors">
				<Roster registry={registry.current} />
				<VersionVectors registry={registry.current} net={net} converged={converged} />
			</section>

			{daveJoined && (
				<section className="latecomer">
					<div className="latecomer-head">
						<h2>Late joiner</h2>
						<span className="muted">
							Dave connected after the edits above. On <code>hello</code> the authority replays the full canonical backlog
							(<code>since(0)</code>), so Dave catches up to the exact same document — no replay logic in app code.
						</span>
					</div>
					<CollabPane peer={PEERS.dave} accent="d" base={base} net={net} register={register} unregister={unregister} onChange={force} />
				</section>
			)}
		</div>
	);
}

// ──────────────────────────────────────────────────────────────────────────────

function CollabPane(props: {
	peer: Peer;
	accent: 'a' | 'b' | 'c' | 'd';
	base: DocumentNode;
	net: MemoryNetwork;
	register: (id: string, collab: Collaborator, editor: EditorRef) => void;
	unregister: (id: string) => void;
	onChange: () => void;
	autoFocus?: boolean;
}): React.ReactElement {
	const handle = useEditorHandle();
	const driver = React.useMemo(() => makeDriver(), []);
	const initial = React.useMemo(() => clone(props.base), [props.base]);
	const collabRef = React.useRef<Collaborator | null>(null);

	const ready = () => {
		const ed = handle.getEditor();
		if (!ed) return;
		collabRef.current?.destroy();
		const collab = new Collaborator({ peer: props.peer, editor: ed, transport: props.net.connect() });
		collab.setPresence({ name: props.peer.name, color: props.peer.color, status: 'editing' });
		collab.onChange(() => props.onChange());
		collabRef.current = collab;
		props.register(props.peer.id, collab, ed);
		props.onChange();
	};

	React.useEffect(() => {
		return () => {
			collabRef.current?.destroy();
			collabRef.current = null;
			props.unregister(props.peer.id);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const collab = collabRef.current;
	const status = collab?.status;
	const selfSel = collab ? handle.getEditor()?.getState().selection : null;

	return (
		<div className={`card editor-card accent-${props.accent}`}>
			<div className="card-head" style={{ borderBottom: `2px solid ${props.peer.color}` }}>
				<h3>
					<span className="dot" style={{ background: props.peer.color }} /> {props.peer.name}
				</h3>
				<span className="badge">{status ? `v${status.head} · ${status.pending} pending${status.inflight ? ' · ⇡' : ''}` : 'connecting…'}</span>
			</div>
			<PlimEditor plim={driver} handle={handle} initialContent={initial} autoFocus={props.autoFocus ?? false} className="editor" whenReady={ready} />
			<RemoteCursors collab={collab} self={props.peer.id} selfSel={selfSel ?? null} />
		</div>
	);
}

// Renders the remote carets THIS peer is aware of — the live awareness surface.
function RemoteCursors(props: { collab: Collaborator | null; self: string; selfSel: Selection | null }): React.ReactElement {
	const peers = props.collab?.peers ?? [];
	return (
		<div className="cursors">
			<div className="cursors-head">
				<span>presence</span>
				<span className="muted">{peers.length} remote</span>
			</div>
			<ul>
				<li>
					<span className="who">
						<span className="dot" style={{ background: '#9ca3af' }} /> you
					</span>
					<span className="caret">{posLabel(props.selfSel)}</span>
				</li>
				{peers.map((p) => (
					<li key={p.peer.id}>
						<span className="who">
							<span className="dot" style={{ background: (p.peer.color as string) ?? '#888' }} /> {p.peer.name ?? p.peer.id}
						</span>
						<span className="caret">{posLabel((p.state.selection as Selection | undefined) ?? null)}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function Roster(props: { registry: Map<string, Registered> }): React.ReactElement {
	const rows = [...props.registry.values()];
	return (
		<div className="panel">
			<h2>Who’s here</h2>
			{rows.length === 0 ? (
				<p className="empty">No peers connected.</p>
			) : (
				<ul className="roster">
					{rows.map(({ collab, editor }) => {
						const sel = editor.getState().selection;
						const s = collab.status;
						return (
							<li key={collab.peer.id}>
								<span className="who">
									<span className="dot" style={{ background: (collab.peer.color as string) ?? '#888' }} /> {collab.peer.name}
								</span>
								<span className="caret">{posLabel(sel)}</span>
								<span className="muted small">
									v{s.head} · {s.pending} pending
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}

function VersionVectors(props: { registry: Map<string, Registered>; net: MemoryNetwork; converged: boolean }): React.ReactElement {
	const rows = [...props.registry.values()];
	return (
		<div className="panel">
			<h2>
				Version vectors{' '}
				{props.converged ? <span className="pill ok">converged</span> : <span className="pill danger">syncing</span>}
			</h2>
			<table className="vv">
				<tbody>
					<tr>
						<th>authority</th>
						<td>
							head <strong>{props.net.authority.head}</strong>
						</td>
						<td className="mono">{vvLabel(props.net.authority.versionVector())}</td>
					</tr>
					{rows.map(({ collab }) => (
						<tr key={collab.peer.id}>
							<th>
								<span className="dot" style={{ background: (collab.peer.color as string) ?? '#888' }} /> {collab.peer.name}
							</th>
							<td>
								v<strong>{collab.status.head}</strong> · {collab.status.pending} pending
							</td>
							<td className="mono">{vvLabel(collab.versionVector())}</td>
						</tr>
					))}
				</tbody>
			</table>
			<p className="hint">
				The authority’s <code>head</code> is the one true version count; each peer’s confirmed <code>v</code> chases it while
				optimistic edits sit in <code>pending</code>. At rest every row matches.
			</p>
		</div>
	);
}
