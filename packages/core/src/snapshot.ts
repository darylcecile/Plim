import type { EditorState } from './transaction.js';

export type SnapshotData = {
	version: 1;
	state: EditorState;
};

export class Snapshot {
	readonly data: SnapshotData;

	constructor(editorOrState: { getState: () => EditorState } | EditorState) {
		const state = 'getState' in editorOrState ? editorOrState.getState() : editorOrState;
		this.data = { version: 1, state: JSON.parse(JSON.stringify(state)) };
	}

	serialize(): string {
		return JSON.stringify(this.data);
	}

	static deserialize(payload: string): Snapshot {
		const data = JSON.parse(payload) as SnapshotData;
		const snap = Object.create(Snapshot.prototype) as Snapshot;
		(snap as { data: SnapshotData }).data = data;
		return snap;
	}
}
