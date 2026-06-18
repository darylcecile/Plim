// Transport + authority — the wire layer that turns a pile of `LedgerRecord`s
// into a converging, shared document.
//
// Three things live here:
//
//  1. **Version vectors** (`VersionVector` + helpers) — a compact `source → seq`
//     summary of "what I've already seen", used for delta sync / late join so a
//     peer can ask only for the records it is missing.
//  2. **The wire DSL** (`CollabMessage`) — a small, JSON-safe discriminated
//     union. It is intentionally generic: any duplex byte channel (WebSocket,
//     BroadcastChannel, WebRTC, postMessage) can carry it. We do NOT reuse the
//     React-Flight wire format; this is its own tiny protocol.
//  3. **A reference authority + in-process network** (`InMemoryAuthority`,
//     `createMemoryNetwork`) — a server-authoritative hub that linearizes
//     submissions into one canonical order, and a loopback network (with
//     optional simulated latency) so examples and tests can run a whole mesh in
//     a single process.
//
// The authority is the convergence guarantee: it owns the single canonical
// ordered log, rebases each submission over the gap the submitter had not yet
// seen, assigns a monotonic `order`, and rebroadcasts records *already in
// canonical position* to everyone. Because every peer therefore applies the
// exact same canonical records in the exact same order, every peer's confirmed
// document is identical by construction — independent of client-side rebase
// quality.

import { type DocumentNode } from '@plim/core';
import type { Selection } from '@plim/core';
import { type EditorState, applyOp } from '@plim/core';
import { type LedgerRecord } from '@plim/ledger';
import { rebaseRecord } from '@plim/ledger';
import type { Transport as GenericTransport } from '@plim/transports';
import type { Peer, PeerId, PresenceState } from './collab-presence.js';

// ---- version vectors --------------------------------------------------------

/**
 * A causal summary: for each `source`, the highest `seq` that has been seen.
 * Records whose `source`/`seq` are already covered need not be re-sent. Records
 * without a `seq` are treated as seq `0` (always covered) — version vectors only
 * track sources that opt into per-source counters.
 */
export type VersionVector = Record<string, number>;

/** Build a version vector summarizing the highest `seq` seen per `source`. */
export function versionVectorOf(records: Iterable<LedgerRecord>): VersionVector {
	const vv: VersionVector = {};
	for (const r of records) {
		const s = r.source ?? '';
		const seq = r.seq ?? 0;
		if (seq > (vv[s] ?? 0)) vv[s] = seq;
	}
	return vv;
}

/** Does `vv` already include `record` (i.e. it has seen this source at >= this seq)? */
export function coversRecord(vv: VersionVector, record: LedgerRecord): boolean {
	return (vv[record.source ?? ''] ?? 0) >= (record.seq ?? 0);
}

/** The subset of `records` that `vv` has not yet seen, in input order. */
export function recordsAfter(records: Iterable<LedgerRecord>, vv: VersionVector): LedgerRecord[] {
	const out: LedgerRecord[] = [];
	for (const r of records) if (!coversRecord(vv, r)) out.push(r);
	return out;
}

/** Pointwise max of two version vectors (the union of what either has seen). */
export function mergeVersionVectors(a: VersionVector, b: VersionVector): VersionVector {
	const out: VersionVector = { ...a };
	for (const k in b) {
		const v = b[k] ?? 0;
		if (v > (out[k] ?? 0)) out[k] = v;
	}
	return out;
}

// ---- wire DSL ---------------------------------------------------------------

/**
 * The collaboration wire protocol — a small JSON-safe discriminated union.
 * Carry it over any duplex channel. Field meanings:
 * - `hello`/`welcome`: handshake. `head` is the authority's canonical length.
 * - `submit`: a client offers records authored against version `base`.
 * - `confirm`: the authority's canonical records starting at `order` (contiguous).
 * - `reject`: ids the authority refused (a rebase bailed) — drop them locally.
 * - `sync`: a late/​re-joining client asks for everything since `have`.
 * - `presence`: ephemeral awareness relay (never touches the ledger).
 * - `bye`: a peer is leaving.
 */
export type CollabMessage =
	| { type: 'hello'; peer: Peer; head: number }
	| { type: 'welcome'; peers: Peer[]; head: number }
	| { type: 'submit'; from: PeerId; base: number; records: LedgerRecord[] }
	| { type: 'confirm'; order: number; records: LedgerRecord[] }
	| { type: 'reject'; ids: string[] }
	| { type: 'sync'; from: PeerId; have: number }
	| { type: 'presence'; peer: Peer; state: PresenceState; clock: number }
	| { type: 'bye'; peerId: PeerId };

/**
 * A bidirectional message channel between one client and the hub.
 *
 * This is the collaboration-specific specialization of the generic
 * `Transport<T>` from `@plim/transports` — `Transport === Transport<CollabMessage>`.
 * Existing code that writes `implements Transport` keeps working unchanged
 * (the shape is identical), and any generic `@plim/transports` wire
 * (`MemoryBus`, `BroadcastChannelTransport`, `WebSocketTransport`) that carries
 * `CollabMessage` is assignable here for free.
 */
export type Transport = GenericTransport<CollabMessage>;

// ---- authority --------------------------------------------------------------

const TRIVIAL_SELECTION: Selection = { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } };

function docState(doc: DocumentNode): EditorState {
	return { doc, selection: TRIVIAL_SELECTION };
}

function foldOps(doc: DocumentNode, record: LedgerRecord): DocumentNode {
	let state = docState(doc);
	for (const op of record.ops) state = applyOp(state, op);
	return state.doc;
}

export interface SubmitResult {
	/** Canonical index where the accepted batch begins. */
	order: number;
	/** The accepted records, transformed into canonical position space, in order. */
	records: LedgerRecord[];
	/** Records the authority refused to integrate (a concurrent change made them ambiguous). */
	dropped: Array<{ id: string; reason: string }>;
}

/**
 * The single source of truth. Holds the canonical ordered log and the canonical
 * document it folds to. `submit` is the linearization point: it rebases the
 * incoming records over the gap the submitter had not yet seen, drops any that
 * can no longer be placed unambiguously (canonical always wins — deterministic),
 * assigns the next `order`, and returns the canonical records to broadcast.
 */
export class InMemoryAuthority {
	private readonly origin: DocumentNode;
	private readonly log: LedgerRecord[] = [];
	private readonly ids = new Set<string>();
	private canonicalDoc: DocumentNode;
	private vv: VersionVector = {};

	constructor(origin: DocumentNode = { type: 'doc', children: [] }) {
		this.origin = origin;
		this.canonicalDoc = origin;
	}

	/** Number of canonical records — the version every confirmed peer converges to. */
	get head(): number {
		return this.log.length;
	}

	/** The canonical document. Every peer's confirmed doc equals this at `head`. */
	get doc(): DocumentNode {
		return this.canonicalDoc;
	}

	/** A snapshot copy of the canonical log. */
	get records(): LedgerRecord[] {
		return this.log.slice();
	}

	/** The starting document every peer must initialize from to replay the log. */
	get originDoc(): DocumentNode {
		return this.origin;
	}

	versionVector(): VersionVector {
		return { ...this.vv };
	}

	/** Canonical records at or after `order` — the payload for delta sync / late join. */
	since(order: number): LedgerRecord[] {
		return this.log.slice(Math.max(0, order));
	}

	/**
	 * Integrate a client's submission. `base` is the canonical length the client
	 * had seen when it authored `records`; anything canonical after `base` is the
	 * concurrent "gap" the records are rebased over. Records whose id is already
	 * canonical are de-duplicated (skipped) so a re-submit can never double-apply.
	 * Note that a skipped record is reported in neither `records` nor `dropped`:
	 * the canonical `confirm` for it was already broadcast once, so a client that
	 * missed it must recover by re-`sync()`ing from its `head`, not by resubmitting.
	 */
	submit(base: number, records: readonly LedgerRecord[]): SubmitResult {
		const clampedBase = Math.max(0, Math.min(base, this.log.length));
		const gap = this.log.slice(clampedBase);
		const startOrder = this.log.length;
		const accepted: LedgerRecord[] = [];
		const dropped: Array<{ id: string; reason: string }> = [];
		let baseDoc: DocumentNode | null = null;

		for (const incoming of records) {
			if (this.ids.has(incoming.id)) continue;
			let record = incoming;
			if (gap.length > 0) {
				if (!baseDoc) baseDoc = this.docAt(clampedBase);
				const result = rebaseRecord(incoming, gap, baseDoc);
				if (!result.ok) {
					dropped.push({ id: incoming.id, reason: result.reason });
					continue;
				}
				record = result.record;
			}
			this.append(record);
			accepted.push(record);
		}
		return { order: startOrder, records: accepted, dropped };
	}

	private append(record: LedgerRecord): void {
		this.log.push(record);
		this.ids.add(record.id);
		this.canonicalDoc = foldOps(this.canonicalDoc, record);
		const s = record.source ?? '';
		const seq = record.seq ?? 0;
		if (seq > (this.vv[s] ?? 0)) this.vv[s] = seq;
	}

	private docAt(order: number): DocumentNode {
		let doc = this.origin;
		for (let i = 0; i < order; i++) doc = foldOps(doc, this.log[i]!);
		return doc;
	}
}

// ---- hub (transport-agnostic server) ---------------------------------------

/**
 * One connected client, from the hub's perspective: a sink the hub pushes
 * canonical and awareness messages into. Wrap any duplex channel (a WebSocket, a
 * worker port, an in-process queue) as a `HubClient` and feed its inbound
 * messages back to the hub via {@link CollabHub.receive}.
 */
export interface HubClient {
	send(message: CollabMessage): void;
}

/**
 * The server half of the protocol, independent of any wire. It owns an
 * {@link InMemoryAuthority} and routes the whole `CollabMessage` stream:
 * handshake (`hello` → `welcome` + full `confirm` backlog + a presence replay),
 * `submit` → linearize → broadcast `confirm` (+ `reject` to the author),
 * delta `sync`, and `presence`/`bye` relay. Pair it with any transport — the
 * bundled {@link MemoryNetwork} uses it in-process, and a real WebSocket server
 * is only a dozen lines around it (see `examples/collab-kitchen-sink`).
 *
 * Ordering contract: the hub calls `client.send` in canonical order per client;
 * your transport MUST preserve that per-connection FIFO on the wire (TCP and
 * WebSocket already do).
 */
export class CollabHub {
	readonly authority: InMemoryAuthority;
	private readonly clients = new Map<HubClient, { peer?: Peer }>();
	private readonly lastPresence = new Map<PeerId, { peer: Peer; state: PresenceState; clock: number }>();

	constructor(origin?: DocumentNode) {
		this.authority = new InMemoryAuthority(origin);
	}

	/** Register a freshly connected client. Call this before routing its messages. */
	add(client: HubClient): void {
		this.clients.set(client, {});
	}

	/** Connected peer ids whose handshake (`hello`) has completed. */
	peers(): PeerId[] {
		const ids: PeerId[] = [];
		for (const meta of this.clients.values()) if (meta.peer) ids.push(meta.peer.id);
		return ids;
	}

	/** Route one inbound message from `client`. May reply to it and/or broadcast. */
	receive(client: HubClient, message: CollabMessage): void {
		const meta = this.clients.get(client);
		if (!meta) return;
		switch (message.type) {
			case 'hello': {
				meta.peer = message.peer;
				const others: Peer[] = [];
				for (const [c, m] of this.clients) if (c !== client && m.peer) others.push(m.peer);
				client.send({ type: 'welcome', peers: others, head: this.authority.head });
				client.send({ type: 'confirm', order: 0, records: this.authority.since(0) });
				for (const p of this.lastPresence.values()) {
					if (p.peer.id !== message.peer.id) client.send({ type: 'presence', peer: p.peer, state: p.state, clock: p.clock });
				}
				break;
			}
			case 'submit': {
				const result = this.authority.submit(message.base, message.records);
				if (result.records.length > 0) {
					const confirm: CollabMessage = { type: 'confirm', order: result.order, records: result.records };
					for (const c of this.clients.keys()) c.send(confirm);
				}
				if (result.dropped.length > 0) client.send({ type: 'reject', ids: result.dropped.map((d) => d.id) });
				break;
			}
			case 'sync': {
				client.send({ type: 'confirm', order: message.have, records: this.authority.since(message.have) });
				break;
			}
			case 'presence': {
				this.lastPresence.set(message.peer.id, { peer: message.peer, state: message.state, clock: message.clock });
				for (const c of this.clients.keys()) if (c !== client) c.send(message);
				break;
			}
			case 'bye': {
				this.lastPresence.delete(message.peerId);
				for (const c of this.clients.keys()) if (c !== client) c.send(message);
				break;
			}
		}
	}

	/** Drop a client and announce its departure (`bye`) to everyone else. */
	remove(client: HubClient): void {
		const meta = this.clients.get(client);
		if (!meta) return;
		this.clients.delete(client);
		const peerId = meta.peer?.id;
		if (peerId) {
			this.lastPresence.delete(peerId);
			const bye: CollabMessage = { type: 'bye', peerId };
			for (const c of this.clients.keys()) c.send(bye);
		}
	}
}

// ---- in-process network -----------------------------------------------------

export interface MemoryNetworkOptions {
	/** The shared starting document every peer replays the canonical log onto. */
	origin?: DocumentNode;
	/** Simulated one-way delivery latency in ms. A function is re-evaluated per message. `0` = synchronous. */
	latencyMs?: number | (() => number);
}

interface Endpoint {
	closed: boolean;
	handlers: Set<(message: CollabMessage) => void>;
	nextAt: number;
	client?: HubClient;
}

/**
 * A loopback collaboration network: one embedded `InMemoryAuthority` plus any
 * number of in-process `Transport`s wired to it. Optional latency makes the
 * optimistic UI observable in examples; with `latencyMs: 0` (the default)
 * delivery is synchronous and fully deterministic, which is what the tests rely
 * on. Per-endpoint delivery is always FIFO, even under random latency, so the
 * canonical `confirm` stream never arrives out of order.
 */
export class MemoryNetwork {
	private readonly hub: CollabHub;
	private readonly latency: () => number;
	private readonly endpoints = new Set<Endpoint>();
	private readonly queue: Array<() => void> = [];
	private draining = false;

	constructor(options: MemoryNetworkOptions = {}) {
		this.hub = new CollabHub(options.origin);
		const lat = options.latencyMs ?? 0;
		this.latency = typeof lat === 'function' ? lat : () => lat;
	}

	/** The embedded authority — the canonical ordered log and the document it folds to. */
	get authority(): InMemoryAuthority {
		return this.hub.authority;
	}

	/** Open a new client transport connected to the hub. */
	connect(): Transport {
		const endpoint: Endpoint = { closed: false, handlers: new Set(), nextAt: 0 };
		this.endpoints.add(endpoint);
		const client: HubClient = { send: (message) => this.deliver(endpoint, message) };
		endpoint.client = client;
		this.hub.add(client);
		return {
			send: (message) => this.hub.receive(client, message),
			onMessage: (handler) => {
				endpoint.handlers.add(handler);
				return () => endpoint.handlers.delete(handler);
			},
			close: () => this.disconnect(endpoint),
		};
	}

	/** Peer ids currently connected (handshake completed). */
	peers(): PeerId[] {
		return this.hub.peers();
	}

	private disconnect(endpoint: Endpoint): void {
		if (endpoint.closed) return;
		endpoint.closed = true;
		this.endpoints.delete(endpoint);
		if (endpoint.client) this.hub.remove(endpoint.client);
	}

	private deliver(endpoint: Endpoint, message: CollabMessage): void {
		const delay = this.latency();
		if (delay <= 0) {
			this.enqueue(() => this.fire(endpoint, message));
			return;
		}
		const at = Math.max(Date.now() + delay, endpoint.nextAt + 0.0001);
		endpoint.nextAt = at;
		setTimeout(() => this.fire(endpoint, message), Math.max(0, at - Date.now()));
	}

	private fire(endpoint: Endpoint, message: CollabMessage): void {
		if (endpoint.closed) return;
		for (const handler of [...endpoint.handlers]) handler(message);
	}

	private enqueue(task: () => void): void {
		this.queue.push(task);
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length > 0) {
				const task = this.queue.shift()!;
				task();
			}
		} finally {
			this.draining = false;
		}
	}
}

/** Create a loopback collaboration network with an embedded authority. */
export function createMemoryNetwork(options: MemoryNetworkOptions = {}): MemoryNetwork {
	return new MemoryNetwork(options);
}
