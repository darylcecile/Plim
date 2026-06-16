// Collaborator — the client end of the collaboration layer.
//
// A `Collaborator` wraps an editor and a `Transport` and gives you live,
// optimistic, convergent multi-peer editing. It is the orchestration layer that
// ties together everything below it:
//
//   transactions → ledger records → rebase → transport/authority → editor
//
// The model is server-authoritative optimistic OT (the same shape ProseMirror's
// `collab` module uses):
//
//   • Local edits apply instantly and are held as `pending` (optimistic).
//   • Exactly one pending record is "in flight" to the authority at a time, so
//     every authority-side rebase is the exact single-record case.
//   • The authority assigns a canonical order and broadcasts records already in
//     canonical position. Clients apply confirmed records RAW (no re-rebase), so
//     every peer's confirmed document is identical by construction — convergence
//     does not depend on client rebase quality.
//   • On each confirmed batch we ack our own record, rebase the rest of pending
//     over the batch (dropping any that can no longer be placed — canonical
//     wins, deterministically), and rebuild the editor as
//     `confirmedDoc + pending` while preserving the LOCAL caret (we never adopt
//     a remote selection).
//
// Presence (cursors/awareness) rides alongside on the same transport but never
// touches the ledger — see `collab-presence.ts`.

import { type DocumentNode, blockTextLength } from '@plim/core';
import { type BlockPath, type CursorPosition, type Selection, getBlockAt } from '@plim/core';
import { type EditorState, type Transaction, type TransactionOp, applyOp } from '@plim/core';
import type { EditorHandle } from '@plim/core';
import { type LedgerRecord, TransactionLedger, recordFromTransaction } from '@plim/ledger';
import { rebaseRecord, rebaseTextPoint } from '@plim/ledger';
import { type CollabMessage, type Transport, type VersionVector, versionVectorOf } from './collab-transport.js';
import { type Peer, type PeerPresence, type PresenceState, PresenceTracker } from './collab-presence.js';

/**
 * The minimal editor surface a `Collaborator` drives. `AgnosticEditor` (and the
 * core `EditorHandle`) satisfy it structurally, so you can pass an editor handle
 * directly. Kept narrow so the collab layer never depends on the renderer.
 */
export type CollabEditor = Pick<EditorHandle, 'getState' | 'setState' | 'onTransaction'>;

export interface CollaboratorOptions {
	/** This client's stable identity. */
	peer: Peer;
	/** The editor to make collaborative. Its current document is taken as the shared origin. */
	editor: CollabEditor;
	/** The channel to the authority/hub. */
	transport: Transport;
	/** Injected clock for presence TTL (defaults to `Date.now`). */
	now?: () => number;
	/** Presence time-to-live in ms before a quiet peer is pruned. */
	ttlMs?: number;
	/**
	 * Liveness heartbeat interval in ms. When set (> 0), the client periodically
	 * re-announces its presence (so peers keep it alive) and prunes remote peers
	 * it has not heard from within `ttlMs` — reclaiming cursors left behind by an
	 * ungraceful disconnect (crash / closed tab) that never sent `bye`. Defaults
	 * to off; graceful `destroy()` always removes a peer instantly regardless.
	 */
	heartbeatMs?: number;
	/** Start the handshake immediately (default `true`). Set `false` to call `start()` yourself. */
	autoStart?: boolean;
}

export interface CollabStatus {
	/** Canonical version (count of confirmed records) this client has applied. */
	head: number;
	/** Number of un-acked optimistic local records. */
	pending: number;
	/** Whether a record is currently awaiting authority confirmation. */
	inflight: boolean;
}

export type CollabChangeListener = (status: CollabStatus) => void;

function isDocMutating(tx: Transaction): boolean {
	for (const op of tx.ops) if (op.kind !== 'setSelection') return true;
	return false;
}

function foldRecord(doc: DocumentNode, record: LedgerRecord): DocumentNode {
	let state: EditorState = { doc, selection: ORIGIN_SELECTION };
	for (const op of record.ops) state = applyOp(state, op);
	return state.doc;
}

const ORIGIN_SELECTION: Selection = { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } };

function clampPosition(pos: CursorPosition, doc: DocumentNode): CursorPosition {
	let block = getBlockAt(doc, pos.path);
	if (!block) {
		const firstPath: BlockPath = doc.children.length > 0 ? [0] : [];
		const first = doc.children[0];
		if (!first) return { path: [0], offset: 0 };
		return { path: firstPath, offset: Math.min(pos.offset, blockTextLength(first)) };
	}
	const len = blockTextLength(block);
	return { path: pos.path.slice(), offset: Math.max(0, Math.min(pos.offset, len)) };
}

function clampSelection(sel: Selection, doc: DocumentNode): Selection {
	return { anchor: clampPosition(sel.anchor, doc), head: clampPosition(sel.head, doc) };
}

/** Thread a single point through a sequence of concurrent ops (best-effort; stops on a deleted block). */
function mapPointThrough(point: CursorPosition, ops: readonly TransactionOp[]): CursorPosition {
	let cur = point;
	for (const op of ops) {
		const mapped = rebaseTextPoint(cur.path, cur.offset, op, 'right');
		if (!mapped) break;
		cur = { path: mapped.path, offset: mapped.offset };
	}
	return cur;
}

function rebaseSelectionOver(sel: Selection, ops: readonly TransactionOp[]): Selection {
	if (ops.length === 0) return sel;
	return { anchor: mapPointThrough(sel.anchor, ops), head: mapPointThrough(sel.head, ops) };
}

/** Thread a remote cursor point through ops, returning `null` if its block was deleted or the op is unmappable. */
function mapRemotePointThrough(point: CursorPosition, ops: readonly TransactionOp[]): CursorPosition | null {
	let cur = point;
	for (const op of ops) {
		const mapped = rebaseTextPoint(cur.path, cur.offset, op, 'right');
		if (!mapped) return null;
		cur = { path: mapped.path, offset: mapped.offset };
	}
	return cur;
}

/** Map a remote selection over concurrent ops; drop it (`null`) if either endpoint's block was deleted. */
function rebaseRemoteSelectionOver(sel: Selection, ops: readonly TransactionOp[]): Selection | null {
	if (ops.length === 0) return sel;
	const anchor = mapRemotePointThrough(sel.anchor, ops);
	const head = mapRemotePointThrough(sel.head, ops);
	if (!anchor || !head) return null;
	return { anchor, head };
}

/**
 * Makes a single editor a live collaborator on a shared document.
 *
 * Typical usage:
 * ```ts
 * const net = createMemoryNetwork({ origin: baseDoc });
 * const me = new Collaborator({ peer: { id: 'alice' }, editor, transport: net.connect() });
 * me.onChange((s) => render(s));            // react to confirmed/pending changes
 * me.setPresence({ status: 'editing' });    // broadcast awareness
 * // ...local edits flow automatically via the editor's transactions.
 * ```
 */
export class Collaborator {
	readonly peer: Peer;
	readonly presence: PresenceTracker;
	/** The confirmed (canonical) log this client has applied — the shared source of truth, for diff/serialize. */
	readonly ledger: TransactionLedger;

	private readonly editor: CollabEditor;
	private readonly transport: Transport;
	private confirmedDoc: DocumentNode;
	private confirmedHead = 0;
	private pending: LedgerRecord[] = [];
	private inflightId: string | null = null;
	private localSeq = 0;
	private lamport = 0;
	private applyingRemote = false;
	private readonly confirmBuffer = new Map<number, LedgerRecord[]>();
	private readonly listeners = new Set<CollabChangeListener>();
	private readonly offTransaction: () => void;
	private readonly offMessage: () => void;
	private readonly heartbeatMs: number;
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private disposed = false;

	constructor(options: CollaboratorOptions) {
		this.peer = options.peer;
		this.editor = options.editor;
		this.transport = options.transport;
		this.heartbeatMs = options.heartbeatMs ?? 0;
		this.presence = new PresenceTracker(options.peer, {
			...(options.now ? { now: options.now } : {}),
			...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
		});
		this.ledger = new TransactionLedger({ source: options.peer.id });
		this.confirmedDoc = options.editor.getState().doc;

		this.offMessage = this.transport.onMessage((m) => this.handleMessage(m));
		this.offTransaction = this.editor.onTransaction((tx) => this.handleLocalTransaction(tx));

		if (options.autoStart !== false) this.start();
	}

	/** Begin the handshake (send `hello`). Called automatically unless `autoStart: false`. */
	start(): void {
		this.transport.send({ type: 'hello', peer: this.peer, head: this.confirmedHead });
		if (this.heartbeatMs > 0 && this.heartbeat === null) {
			this.heartbeat = setInterval(() => this.tickLiveness(), this.heartbeatMs);
		}
	}

	/** Re-announce our presence (keep us alive on peers) and prune peers gone silent past their TTL. */
	private tickLiveness(): void {
		if (this.disposed) return;
		const bc = this.presence.touchLocal();
		this.transport.send({ type: 'presence', peer: bc.peer, state: bc.state, clock: bc.clock });
		if (this.presence.prune().length > 0) this.emit();
	}

	// ---- status & inspection ----

	get status(): CollabStatus {
		return { head: this.confirmedHead, pending: this.pending.length, inflight: this.inflightId !== null };
	}

	/** The optimistic document currently shown in the editor (confirmed + pending). */
	get document(): DocumentNode {
		return this.editor.getState().doc;
	}

	/** The confirmed/canonical document (excludes un-acked local edits). */
	get confirmedDocument(): DocumentNode {
		return this.confirmedDoc;
	}

	/** Other peers' presence (what you render as remote cursors). */
	get peers(): PeerPresence[] {
		return this.presence.remotePeers();
	}

	/** This client's view vector — the highest `seq` seen per source. */
	versionVector(): VersionVector {
		return versionVectorOf(this.ledger.records);
	}

	onChange(listener: CollabChangeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	// ---- presence ----

	/** Replace this client's awareness state and broadcast it. */
	setPresence(state: PresenceState): void {
		const bc = this.presence.setLocal(state);
		this.transport.send({ type: 'presence', peer: bc.peer, state: bc.state, clock: bc.clock });
	}

	/** Merge a partial patch into this client's awareness state and broadcast it. */
	patchPresence(patch: Partial<PresenceState>): void {
		const bc = this.presence.patchLocal(patch);
		this.transport.send({ type: 'presence', peer: bc.peer, state: bc.state, clock: bc.clock });
	}

	/** Request any canonical records this client is missing (late join / reconnect). */
	sync(): void {
		this.transport.send({ type: 'sync', from: this.peer.id, have: this.confirmedHead });
	}

	/** Detach from the editor and transport, announcing departure. */
	destroy(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.heartbeat !== null) {
			clearInterval(this.heartbeat);
			this.heartbeat = null;
		}
		this.transport.send({ type: 'bye', peerId: this.peer.id });
		this.offTransaction();
		this.offMessage();
		this.transport.close();
		this.presence.clear();
		this.listeners.clear();
	}

	// ---- local edits ----

	private handleLocalTransaction(tx: Transaction): void {
		if (this.applyingRemote || this.disposed) return;
		const selection = this.editor.getState().selection;
		if (!isDocMutating(tx)) {
			this.broadcastSelection(selection);
			return;
		}
		this.lamport += 1;
		this.localSeq += 1;
		const record = recordFromTransaction(tx, { source: this.peer.id, lamport: this.lamport });
		record.seq = this.localSeq;
		this.pending.push(record);
		this.broadcastSelection(selection);
		// The local edit shifts the document under every remote caret; map them over
		// it so they keep tracking their text as you type (the editor has already
		// applied this tx, so the clamp targets the post-edit doc).
		this.rebaseRemoteCursors(() => tx.ops);
		this.flush();
		this.emit();
	}

	private flush(): void {
		if (this.inflightId !== null || this.pending.length === 0 || this.disposed) return;
		const next = this.pending[0]!;
		this.inflightId = next.id;
		this.transport.send({ type: 'submit', from: this.peer.id, base: this.confirmedHead, records: [next] });
	}

	private broadcastSelection(selection: Selection): void {
		const bc = this.presence.setLocalSelection(selection);
		this.transport.send({ type: 'presence', peer: bc.peer, state: bc.state, clock: bc.clock });
	}

	// ---- inbound ----

	private handleMessage(message: CollabMessage): void {
		if (this.disposed) return;
		switch (message.type) {
			case 'confirm':
				this.bufferConfirm(message.order, message.records);
				break;
			case 'reject':
				this.handleReject(message.ids);
				break;
			case 'presence':
				if (this.presence.applyRemote({ peer: message.peer, state: message.state, clock: message.clock })) this.emit();
				break;
			case 'bye':
				if (this.presence.remove(message.peerId)) this.emit();
				break;
			case 'welcome':
			case 'hello':
			case 'submit':
			case 'sync':
				break;
		}
	}

	private handleReject(ids: string[]): void {
		const drop = new Set(ids);
		const before = this.pending.length;
		this.pending = this.pending.filter((p) => !drop.has(p.id));
		if (this.inflightId && drop.has(this.inflightId)) this.inflightId = null;
		if (this.pending.length !== before) this.recomputeEditor([]);
		this.flush();
		this.emit();
	}

	private bufferConfirm(order: number, records: LedgerRecord[]): void {
		this.confirmBuffer.set(order, records);
		this.drainConfirms();
	}

	/** Apply buffered confirm batches in canonical order, trimming any overlap. */
	private drainConfirms(): void {
		let progressed = true;
		while (progressed) {
			progressed = false;
			for (const [order, records] of this.confirmBuffer) {
				const end = order + records.length;
				if (end <= this.confirmedHead) {
					this.confirmBuffer.delete(order);
					progressed = true;
					break;
				}
				if (order <= this.confirmedHead) {
					this.confirmBuffer.delete(order);
					const skip = this.confirmedHead - order;
					this.applyConfirmedBatch(skip > 0 ? records.slice(skip) : records);
					progressed = true;
					break;
				}
			}
		}
	}

	private applyConfirmedBatch(records: LedgerRecord[]): void {
		if (records.length === 0) return;
		const prevConfirmed = this.confirmedDoc;
		const pendingIds = new Set(this.pending.map((p) => p.id));
		// Partition the canonical batch: records that ack our own pending vs. genuinely remote records we
		// have not seen. A live confirm is purely one or the other (the authority confirms one in-flight
		// record at a time). A reconnect or `sync` backlog can legitimately carry BOTH at once — our own
		// record that landed canonically while our socket was down (its confirm was lost) interleaved with
		// remote edits made in the meantime — because the hub replies with the whole backlog from our
		// confirmed head in one batch. Handling both partitions below lets a mixed batch CONVERGE instead
		// of corrupting the editor (or, as it once did, throwing and wedging the client on every reconnect).
		const acked = records.filter((r) => pendingIds.has(r.id));
		const remote = records.filter((r) => !pendingIds.has(r.id));

		// Advance the canonical doc by folding records RAW (they are already in canonical position),
		// and grow the confirmed ledger — the shared source of truth that converges across peers.
		// (Convergence holds regardless of how pending is rebased below: confirmedDoc is always the
		// authority's exact canonical fold.)
		for (const rec of records) {
			this.confirmedDoc = foldRecord(this.confirmedDoc, rec);
			this.ledger.append(rec);
		}
		this.confirmedHead += records.length;

		// Ack our own now-canonical records: drop them from the optimistic pending chain.
		if (acked.length > 0) {
			const ackedIds = new Set(acked.map((r) => r.id));
			this.pending = this.pending.filter((p) => !ackedIds.has(p.id));
			if (this.inflightId && ackedIds.has(this.inflightId)) this.inflightId = null;
		}

		if (remote.length === 0) {
			// Pure self-ack. The remaining pending were authored ON TOP of the acked records (optimistic
			// chain) and our local copy was rebased over the same prior remote confirms the authority used
			// (per-endpoint FIFO guarantees we saw that gap first). So the editor ALREADY shows exactly
			// `confirmedDoc + pending` — re-setting state would rebuild the doc under the user's caret for
			// zero visible change. We leave the editor untouched, which keeps the caret rock-steady while
			// you type. (Invariant editor.doc === confirmedDoc + pending is preserved: confirmedDoc grew by
			// the acked records, pending shrank by the same.)
		} else {
			// We saw remote records we had not confirmed — either a purely concurrent batch, or (after a
			// reconnect) a backlog that also carried our own now-acked record. Our surviving pending is
			// concurrent with the REMOTE ops only — our own acked records were already part of its
			// optimistic base — so rebase pending over just `remote` (dropping any that can no longer be
			// placed — canonical wins, deterministically) and shift the local caret over the remote ops.
			const remoteOps = remote.flatMap((r) => r.ops);
			this.rebasePendingOver(remote, prevConfirmed);
			this.recomputeEditor(remoteOps);
			// Shift other peers' carets over the same remote ops, but skip ops a peer
			// authored itself — that peer's own presence broadcast already reflects
			// them, so re-mapping would over-shoot its caret.
			this.rebaseRemoteCursors((peer) => remote.filter((r) => r.source !== peer.id).flatMap((r) => r.ops));
		}

		this.flush();
		this.emit();
	}

	/** Rebase the optimistic pending chain over a concurrent remote batch; keep the in-flight record for ack-by-id even if it bails. */
	private rebasePendingOver(over: LedgerRecord[], baseDoc: DocumentNode): void {
		if (this.pending.length === 0) return;
		const next: LedgerRecord[] = [];
		for (const p of this.pending) {
			const result = rebaseRecord(p, over, baseDoc);
			if (result.ok) next.push(result.record);
			else if (p.id === this.inflightId) next.push(p);
		}
		this.pending = next;
	}

	private recomputeEditor(remoteOps: readonly TransactionOp[]): void {
		const localSelection = this.editor.getState().selection;
		const rebasedSelection = rebaseSelectionOver(localSelection, remoteOps);
		let state: EditorState = { doc: this.confirmedDoc, selection: rebasedSelection };
		for (const rec of this.pending) {
			for (const op of rec.ops) state = applyOp(state, op);
		}
		const finalSelection = clampSelection(rebasedSelection, state.doc);
		this.applyingRemote = true;
		try {
			this.editor.setState({ doc: state.doc, selection: finalSelection });
		} finally {
			this.applyingRemote = false;
		}
	}

	/**
	 * Keep other people's carets tracking the text as the document mutates beneath
	 * them — the remote-cursor analogue of the local-caret rebase in
	 * `recomputeEditor`. For each stored remote peer we map its selection over the
	 * ops `opsFor(peer)` returns (then clamp into the current doc), dropping any
	 * caret whose block was deleted. `opsFor` is per-peer so the confirmed-batch
	 * path can exclude the ops a peer authored itself: that peer's own broadcast
	 * already reflects them, and mapping over them again would over-shoot its
	 * caret. Must run after the editor doc has advanced so the clamp targets the
	 * new document.
	 */
	private rebaseRemoteCursors(opsFor: (peer: Peer) => readonly TransactionOp[]): void {
		if (this.presence.size === 0) return;
		const doc = this.editor.getState().doc;
		this.presence.mapSelections((sel, peer) => {
			const ops = opsFor(peer);
			if (ops.length === 0) return sel;
			const mapped = rebaseRemoteSelectionOver(sel, ops);
			return mapped ? clampSelection(mapped, doc) : null;
		});
	}

	private emit(): void {
		if (this.listeners.size === 0) return;
		const status = this.status;
		for (const l of this.listeners) l(status);
	}
}
