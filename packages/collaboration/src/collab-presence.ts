// Presence (a.k.a. awareness) — the ephemeral, per-peer state that makes a
// document feel "live": who is here, where their caret is, what they are doing.
//
// Presence is deliberately NOT part of the ledger. It is throwaway state that
// is broadcast best-effort, never persisted, and dropped as soon as a peer
// leaves: a graceful departure sends `bye` (removed instantly), while an
// ungraceful one (crash, closed tab, dropped socket) is reclaimed by TTL — the
// `Collaborator`'s opt-in heartbeat refreshes live peers and prunes silent ones
// (see `prune`/`touchLocal`). Keeping presence off the ledger is what keeps it
// fast — a caret moving every keystroke must never grow the durable log. Each
// peer stamps its updates with a monotonic per-peer `clock` so out-of-order
// delivery can be discarded cheaply without any document on hand.
//
// This module is self-contained: it knows nothing about transports, ledgers, or
// the authority. `Collaborator` (collab.ts) wires it to a `Transport`.

import type { Selection } from '@plim/core';

export type PeerId = string;

/** Stable identity of a collaborator. `meta` carries anything app-specific. */
export interface Peer {
	id: PeerId;
	name?: string;
	color?: string;
	meta?: Record<string, unknown>;
}

/**
 * Ephemeral awareness state for a single peer. `selection` is the peer's caret /
 * selection in the shared document (the thing you render as a remote cursor);
 * everything else is free-form (e.g. `isTyping`, `status`, `viewport`).
 */
export interface PresenceState {
	selection?: Selection | null;
	[field: string]: unknown;
}

/** A peer plus its current presence, tagged with liveness bookkeeping. */
export interface PeerPresence {
	peer: Peer;
	state: PresenceState;
	/** Monotonic per-peer logical clock; higher always wins, stale updates are dropped. */
	clock: number;
	/** Wall-clock ms of the last update we accepted, for TTL pruning. */
	lastSeen: number;
}

export type PresenceEvent =
	| { kind: 'join'; peerId: PeerId; presence: PeerPresence }
	| { kind: 'update'; peerId: PeerId; presence: PeerPresence }
	| { kind: 'leave'; peerId: PeerId; peer: Peer };

/** Called after every accepted change. `remotes` excludes the local peer. */
export type PresenceListener = (event: PresenceEvent, remotes: PeerPresence[]) => void;

export interface PresenceTrackerOptions {
	/** Injectable clock (defaults to `Date.now`) — handy for deterministic tests. */
	now?: () => number;
	/** Drop remote peers not seen within this many ms on `prune()`. `0` disables. Default `30000`. */
	ttlMs?: number;
}

/** A presence update ready to put on the wire. */
export interface PresenceBroadcast {
	peer: Peer;
	state: PresenceState;
	clock: number;
}

function clonePresence(state: PresenceState): PresenceState {
	return JSON.parse(JSON.stringify(state)) as PresenceState;
}

/** Cheap structural equality for presence states (small, JSON-safe objects). */
function presenceStateEqual(a: PresenceState, b: PresenceState): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Structural equality between two selection-field values; either side may be `null`/`undefined`. */
function selectionFieldEqual(a: Selection | null | undefined, b: Selection | null | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Tracks the local peer's presence plus every remote peer's last-known
 * presence. Pure in-memory bookkeeping with a tiny event surface; transport is
 * someone else's job.
 *
 * - `setLocal` / `patchLocal` mutate the local peer and return a
 *   `PresenceBroadcast` to ship (the caller decides when/how to send it).
 * - `applyRemote` integrates an inbound update, ignoring anything stale by
 *   `clock`, and emits `join`/`update`.
 * - `remove` / `prune` retire peers and emit `leave`.
 */
export class PresenceTracker {
	readonly self: Peer;
	private readonly now: () => number;
	private readonly ttlMs: number;
	private localState: PresenceState = {};
	private localClock = 0;
	private readonly remotes = new Map<PeerId, PeerPresence>();
	private readonly listeners = new Set<PresenceListener>();

	constructor(self: Peer, options: PresenceTrackerOptions = {}) {
		this.self = self;
		this.now = options.now ?? Date.now;
		this.ttlMs = options.ttlMs ?? 30_000;
	}

	/** The local peer's current presence (clock + lastSeen reflect the last `setLocal`). */
	get local(): PeerPresence {
		return { peer: this.self, state: this.localState, clock: this.localClock, lastSeen: this.now() };
	}

	/** Replace the local presence wholesale. Bumps the local clock. Returns the value to broadcast. */
	setLocal(state: PresenceState): PresenceBroadcast {
		this.localState = clonePresence(state);
		this.localClock += 1;
		return { peer: this.self, state: this.localState, clock: this.localClock };
	}

	/** Merge a partial patch into the local presence. Bumps the local clock. Returns the value to broadcast. */
	patchLocal(patch: Partial<PresenceState>): PresenceBroadcast {
		return this.setLocal({ ...this.localState, ...patch });
	}

	/**
	 * Re-announce the current local presence with a fresh clock — a liveness
	 * heartbeat. Peers accept it (newer clock) and refresh their `lastSeen` for
	 * us, but since the state is unchanged it fires no `update` event on their
	 * side. Returns the value to broadcast.
	 */
	touchLocal(): PresenceBroadcast {
		this.localClock += 1;
		return { peer: this.self, state: this.localState, clock: this.localClock };
	}

	/** Convenience: set just the local caret/selection. */
	setLocalSelection(selection: Selection | null): PresenceBroadcast {
		return this.patchLocal({ selection });
	}

	/**
	 * Integrate a remote presence update. Updates with a `clock` at or below the
	 * one we already hold for that peer are ignored (stale / duplicate). The
	 * local peer's own echoes are ignored. A newer `clock` carrying an unchanged
	 * state is treated as a liveness heartbeat: we refresh `lastSeen` (so TTL
	 * pruning keeps the peer) but report no change, so idle heartbeats never
	 * trigger a re-render. Returns `true` only when the visible state changed.
	 */
	applyRemote(broadcast: PresenceBroadcast): boolean {
		const { peer, state, clock } = broadcast;
		if (peer.id === this.self.id) return false;
		const existing = this.remotes.get(peer.id);
		if (existing && clock <= existing.clock) return false;
		const presence: PeerPresence = { peer, state: clonePresence(state), clock, lastSeen: this.now() };
		this.remotes.set(peer.id, presence);
		if (existing && presenceStateEqual(existing.state, presence.state)) return false; // heartbeat: liveness only
		this.emit(existing ? { kind: 'update', peerId: peer.id, presence } : { kind: 'join', peerId: peer.id, presence });
		return true;
	}

	/**
	 * Remap every remote peer's caret/selection through `mapper`. This keeps
	 * remote cursors tracking the text as the LOCAL document mutates beneath them
	 * — your own edits, or a third peer's confirmed ops — in between that peer's
	 * own presence broadcasts. A stored `selection` is an absolute
	 * `{path, offset}`; without remapping it silently drifts onto the wrong text
	 * after any concurrent edit, then visibly jumps when the peer next broadcasts.
	 *
	 * `mapper` receives a peer's current selection plus its `Peer` (so the caller
	 * can, say, skip ops that peer authored itself) and returns the transformed
	 * selection, or `null` to drop the caret (e.g. its block was deleted) until
	 * the peer broadcasts afresh. Peers with no selection are skipped.
	 *
	 * The per-peer `clock`/`lastSeen` are deliberately left untouched: this is a
	 * local cosmetic transform, not a new update from the peer, so the peer's next
	 * genuine broadcast (higher `clock`) still wins and re-syncs any drift. Stays
	 * ledger-agnostic — the caller supplies the position math. Returns `true` if
	 * any stored selection changed (so the caller can re-render).
	 */
	mapSelections(mapper: (selection: Selection, peer: Peer) => Selection | null): boolean {
		let changed = false;
		for (const presence of this.remotes.values()) {
			const current = presence.state.selection;
			if (!current) continue;
			const mapped = mapper(current, presence.peer);
			if (selectionFieldEqual(current, mapped)) continue;
			presence.state = { ...presence.state, selection: mapped };
			changed = true;
		}
		return changed;
	}

	/** Retire a remote peer (e.g. it sent `bye`). Emits `leave`. */
	remove(peerId: PeerId): boolean {
		const existing = this.remotes.get(peerId);
		if (!existing) return false;
		this.remotes.delete(peerId);
		this.emit({ kind: 'leave', peerId, peer: existing.peer });
		return true;
	}

	/**
	 * Drop remote peers whose last update is older than `ttlMs`. Returns the ids
	 * removed; emits `leave` for each. A no-op when `ttlMs` is `0`.
	 */
	prune(at: number = this.now()): PeerId[] {
		if (this.ttlMs <= 0) return [];
		const removed: PeerId[] = [];
		for (const [id, p] of this.remotes) {
			if (at - p.lastSeen > this.ttlMs) removed.push(id);
		}
		for (const id of removed) this.remove(id);
		return removed;
	}

	has(peerId: PeerId): boolean {
		return this.remotes.has(peerId);
	}

	get(peerId: PeerId): PeerPresence | undefined {
		return this.remotes.get(peerId);
	}

	/** Remote peers only (what you typically render as other people's cursors). */
	remotePeers(): PeerPresence[] {
		return [...this.remotes.values()];
	}

	/** Every peer including the local one. */
	allPeers(): PeerPresence[] {
		return [this.local, ...this.remotes.values()];
	}

	get size(): number {
		return this.remotes.size;
	}

	onChange(listener: PresenceListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Forget all remote peers without emitting (e.g. on disconnect/teardown). */
	clear(): void {
		this.remotes.clear();
	}

	private emit(event: PresenceEvent): void {
		const remotes = this.remotePeers();
		for (const l of this.listeners) l(event, remotes);
	}
}
