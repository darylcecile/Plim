import * as React from 'react';
import {
	PlimDriver,
	boldMark,
	codeMark,
	defineAction,
	headingBlock,
	italicMark,
	paragraphBlock,
	triggers,
	type BlockNode,
	type DocumentNode,
	type EditorState,
	type Selection,
} from '@plim/core';
import {
	TransactionLedger,
	applyLedgerRecord,
	diffLedgers,
	findConflicts,
	firstWriteWins,
	lastWriteWins,
	mergeLedgers,
	preferSource,
	rebaseRecords,
	resolveConflicts,
	summarizeRecord,
	type LedgerRecord,
} from '@plim/ledger';
import { PlimEditor, useEditorHandle } from '@plim/react';

// ──────────────────────────────────────────────────────────────────────────────
// One driver definition, instantiated three times so editors A / B / C keep
// fully independent state. The driver only carries *config* (blocks, marks,
// actions) — the document lives in each editor's EditorState.
// ──────────────────────────────────────────────────────────────────────────────

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
					const sel = state.selection;
					const tx = ctx.createTransaction();
					tx.toggleMark('bold', { from: sel.anchor, to: sel.head });
					tx.commit();
				},
			}),
			defineAction('italic', {
				trigger: triggers.keyboard.shortcut('Mod+i'),
				triggerValidationRules: ({ and }) => and(['selectionNotEmpty', 'blockSupportsDecoration']),
				perform: async (state, ctx) => {
					const sel = state.selection;
					const tx = ctx.createTransaction();
					tx.toggleMark('italic', { from: sel.anchor, to: sel.head });
					tx.commit();
				},
			}),
		],
	});
}

// ──────────────────────────────────────────────────────────────────────────────
// The shared base document — the common ancestor both clients branch from.
// `[1]` is the paragraph both demo edits target (offsets 4..9 = "quick").
// ──────────────────────────────────────────────────────────────────────────────

function makeBase(): DocumentNode {
	return {
		type: 'doc',
		children: [
			{ id: 'h', type: 'heading', attrs: { level: 2 }, text: [{ text: 'Shared starting document' }] },
			{ id: 'p1', type: 'paragraph', text: [{ text: 'The quick brown fox jumps over the lazy dog.' }] },
			{ id: 'p2', type: 'paragraph', text: [{ text: 'Both clients branch from this exact text.' }] },
			{ id: 'p3', type: 'paragraph', text: [{ text: 'Edit offline, then reconcile with the ledger tools.' }] },
		],
	};
}

const TRIVIAL: Selection = { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } };

function clone<T>(v: T): T {
	return JSON.parse(JSON.stringify(v)) as T;
}

function blockText(b: BlockNode): string {
	const own = (b.text ?? []).map((t) => t.text).join('');
	const kids = (b.children ?? []).map(blockText).join(' ');
	return [own, kids].filter(Boolean).join(' ');
}

function docToText(doc: DocumentNode): string {
	return doc.children.map(blockText).join('\n');
}

function shortId(id: string): string {
	return id.length > 6 ? `…${id.slice(-5)}` : id;
}

function opSummary(rec: LedgerRecord): string {
	const s = summarizeRecord(rec);
	const kinds = Object.entries(s.opKinds)
		.map(([k, n]) => `${k}×${n}`)
		.join(', ');
	return kinds || '(no ops)';
}

// ──────────────────────────────────────────────────────────────────────────────
// Reconciliation report — the output of whichever ledger tool was last run.
// ──────────────────────────────────────────────────────────────────────────────

type Recon =
	| { kind: 'merge'; timeline: LedgerRecord[]; conflictIds: Set<string>; pairs: Array<[LedgerRecord, LedgerRecord]> }
	| { kind: 'resolve'; kept: LedgerRecord[]; dropped: Array<{ record: LedgerRecord; conflictsWith: LedgerRecord }>; strategy: string }
	| { kind: 'rebase'; rebased: LedgerRecord[]; failed: Array<{ record: LedgerRecord; reason: string }> }
	| { kind: 'diff'; common: LedgerRecord[]; onlyInB: LedgerRecord[] }
	| { kind: 'serialize'; bytes: number; count: number; equal: boolean; sample: string };

const STRATEGIES = {
	lastWriteWins: { label: 'last-write-wins', fn: lastWriteWins },
	firstWriteWins: { label: 'first-write-wins', fn: firstWriteWins },
	preferA: { label: 'prefer Client A', fn: preferSource(['clientA', 'clientB']) },
	preferB: { label: 'prefer Client B', fn: preferSource(['clientB', 'clientA']) },
} as const;

type StrategyName = keyof typeof STRATEGIES;

export function App(): React.ReactElement {
	const handleA = useEditorHandle();
	const handleB = useEditorHandle();
	const handleC = useEditorHandle();

	const ledgerA = React.useMemo(() => new TransactionLedger({ source: 'clientA' }), []);
	const ledgerB = React.useMemo(() => new TransactionLedger({ source: 'clientB' }), []);

	const driverA = React.useMemo(() => makeDriver(), []);
	const driverB = React.useMemo(() => makeDriver(), []);
	const driverC = React.useMemo(() => makeDriver(), []);

	const base = React.useMemo(() => makeBase(), []);
	const initA = React.useMemo(() => clone(base), [base]);
	const initB = React.useMemo(() => clone(base), [base]);
	const initC = React.useMemo(() => clone(base), [base]);

	const detachA = React.useRef<(() => void) | null>(null);
	const detachB = React.useRef<(() => void) | null>(null);

	const [, force] = React.useReducer((n: number) => n + 1, 0);
	const [recon, setRecon] = React.useState<Recon | null>(null);
	const [strategy, setStrategy] = React.useState<StrategyName>('lastWriteWins');

	// Re-render the ledger logs whenever either ledger records a new entry.
	React.useEffect(() => {
		const offs = [ledgerA.onRecord(() => force()), ledgerB.onRecord(() => force())];
		return () => offs.forEach((f) => f());
	}, [ledgerA, ledgerB]);

	React.useEffect(() => {
		return () => {
			detachA.current?.();
			detachB.current?.();
		};
	}, []);

	const subscribe = (handle: ReturnType<typeof useEditorHandle>, ledger: TransactionLedger, ref: React.MutableRefObject<(() => void) | null>) => () => {
		const ed = handle.getEditor();
		if (!ed) return;
		ref.current?.();
		ref.current = ledger.attach(ed);
	};

	const seedResult = (records: readonly LedgerRecord[]) => {
		const ed = handleC.getEditor();
		if (!ed) return;
		let st: EditorState = { doc: clone(base), selection: clone(TRIVIAL) };
		for (const r of records) st = applyLedgerRecord(st, r);
		ed.setState(st);
	};

	// ── Ledger tools ──────────────────────────────────────────────────────────

	const onMerge = () => {
		const merged = mergeLedgers(ledgerA, ledgerB);
		const pairs = findConflicts(merged.records);
		const conflictIds = new Set<string>();
		for (const [a, b] of pairs) {
			conflictIds.add(a.id);
			conflictIds.add(b.id);
		}
		seedResult(merged.records); // naive union — conflicting edits both land, last wins per op order
		setRecon({ kind: 'merge', timeline: merged.records.slice(), conflictIds, pairs });
	};

	const onResolve = () => {
		const merged = mergeLedgers(ledgerA, ledgerB);
		const { kept, dropped } = resolveConflicts(merged.records, STRATEGIES[strategy].fn);
		seedResult(kept);
		setRecon({ kind: 'resolve', kept, dropped, strategy: STRATEGIES[strategy].label });
	};

	const onRebase = () => {
		// Keep BOTH sides: take A's edits as-is, transform B's edits to sit on top.
		const { rebased, failed } = rebaseRecords(ledgerB.records, ledgerA.records as LedgerRecord[], base);
		seedResult([...ledgerA.records, ...rebased]);
		setRecon({ kind: 'rebase', rebased, failed });
	};

	const onDiff = () => {
		// "What does Client A still need to pull?" — diff A against the union.
		const merged = mergeLedgers(ledgerA, ledgerB);
		const d = diffLedgers(ledgerA, merged);
		setRecon({ kind: 'diff', common: d.common, onlyInB: d.onlyInB });
	};

	const onSerialize = () => {
		const json = ledgerA.serialize();
		const restored = TransactionLedger.deserialize(json);
		let a: EditorState = { doc: clone(base), selection: clone(TRIVIAL) };
		for (const r of ledgerA.records) a = applyLedgerRecord(a, r);
		let b: EditorState = { doc: clone(base), selection: clone(TRIVIAL) };
		for (const r of restored.records) b = applyLedgerRecord(b, r);
		const equal = JSON.stringify(a.doc) === JSON.stringify(b.doc);
		setRecon({ kind: 'serialize', bytes: json.length, count: restored.length, equal, sample: json.slice(0, 280) });
	};

	const resetAll = () => {
		ledgerA.clear();
		ledgerB.clear();
		for (const h of [handleA, handleB, handleC]) {
			h.getEditor()?.setState({ doc: clone(base), selection: clone(TRIVIAL) });
		}
		setRecon(null);
		force();
	};

	// Deterministic, screenshot-friendly scenario: one true conflict (both edit
	// "quick" in p1) plus one disjoint edit on each side (p2 / p3).
	const seedDemo = () => {
		resetAll();
		const a = handleA.getEditor();
		const b = handleB.getEditor();
		if (!a || !b) return;
		const a1 = a.createTransaction();
		a1.replaceRange([1], 4, 9, [{ text: 'rapid' }]);
		a1.commit();
		const a2 = a.createTransaction();
		a2.insertText([2], 0, 'A says: ');
		a2.commit();
		const b1 = b.createTransaction();
		b1.replaceRange([1], 4, 9, [{ text: 'swift' }]);
		b1.commit();
		const b2 = b.createTransaction();
		b2.insertText([3], 0, 'B says: ');
		b2.commit();
	};

	// ── Render ──────────────────────────────────────────────────────────────────

	return (
		<div className="page">
			<header className="hero">
				<h1>Ledger kitchen sink</h1>
				<p>
					Two clients edit the <strong>same starting document</strong> offline. Every committed transaction is captured in a{' '}
					<code>TransactionLedger</code>. Then reconcile them with merge, conflict detection, drop-one-side resolution, OT
					rebase (keep both), diff, and serialize — all from <code>@plim/core</code>.
				</p>
				<div className="toolbar">
					<button className="primary" onClick={seedDemo}>
						① Load demo edits
					</button>
					<button onClick={onMerge}>② Merge &amp; detect conflicts</button>
					<label className="strategy">
						strategy
						<select name="strategy" value={strategy} onChange={(e) => setStrategy(e.target.value as StrategyName)}>
							{Object.entries(STRATEGIES).map(([k, v]) => (
								<option key={k} value={k}>
									{v.label}
								</option>
							))}
						</select>
					</label>
					<button onClick={onResolve}>③ Resolve (drop one side)</button>
					<button onClick={onRebase}>④ Rebase B→A (keep both)</button>
					<button onClick={onDiff}>⑤ Diff</button>
					<button onClick={onSerialize}>⑥ Serialize round-trip</button>
					<button className="ghost" onClick={resetAll}>
						Reset
					</button>
				</div>
				<p className="hint">
					You can also type freely in either editor (⌘/Ctrl+B, ⌘/Ctrl+I for marks). Records appear live below each editor.
				</p>
			</header>

			<section className="grid">
				<EditorCard
					title="Client A"
					accent="a"
					driver={driverA}
					handle={handleA}
					initial={initA}
					ledger={ledgerA}
					onReady={subscribe(handleA, ledgerA, detachA)}
				/>
				<EditorCard
					title="Client B"
					accent="b"
					driver={driverB}
					handle={handleB}
					initial={initB}
					ledger={ledgerB}
					onReady={subscribe(handleB, ledgerB, detachB)}
				/>
			</section>

			<section className="recon">
				<div className="recon-report">
					<h2>Reconciliation</h2>
					<ReconView recon={recon} />
				</div>
				<div className="card result">
					<div className="card-head">
						<h3>Result (Client C)</h3>
						<span className="muted">read-only · driven by the buttons above</span>
					</div>
					<PlimEditor
						plim={driverC}
						handle={handleC}
						initialContent={initC}
						readonly
						className="editor"
						whenReady={() => handleC.getEditor()?.setState({ doc: clone(base), selection: clone(TRIVIAL) })}
					/>
				</div>
			</section>
		</div>
	);
}

function EditorCard(props: {
	title: string;
	accent: 'a' | 'b';
	driver: PlimDriver;
	handle: ReturnType<typeof useEditorHandle>;
	initial: DocumentNode;
	ledger: TransactionLedger;
	onReady: () => void;
}): React.ReactElement {
	return (
		<div className={`card editor-card accent-${props.accent}`}>
			<div className="card-head">
				<h3>{props.title}</h3>
				<span className="badge">source: {props.ledger.source}</span>
			</div>
			<PlimEditor
				plim={props.driver}
				handle={props.handle}
				initialContent={props.initial}
				autoFocus={props.accent === 'a'}
				className="editor"
				whenReady={props.onReady}
			/>
			<LedgerLog ledger={props.ledger} />
		</div>
	);
}

function LedgerLog(props: { ledger: TransactionLedger }): React.ReactElement {
	const records = props.ledger.records;
	return (
		<div className="log">
			<div className="log-head">
				<span>Ledger</span>
				<span className="muted">
					{records.length} record{records.length === 1 ? '' : 's'} · clock {props.ledger.clock}
				</span>
			</div>
			{records.length === 0 ? (
				<p className="empty">No records yet — edit the document above.</p>
			) : (
				<ul>
					{records.map((r) => (
						<li key={r.id}>
							<code className="rid">{shortId(r.id)}</code>
							<span className="lamport">L{r.lamport}</span>
							<span className="ops">{opSummary(r)}</span>
							<span className="touch">{summarizeRecord(r).blocks.map(shortId).join(', ') || '—'}</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function RecordChip(props: { rec: LedgerRecord; warn?: boolean }): React.ReactElement {
	const s = summarizeRecord(props.rec);
	return (
		<span className={`chip${props.warn ? ' warn' : ''}`}>
			<strong>{s.source ?? '?'}</strong> <code>{shortId(props.rec.id)}</code> · {opSummary(props.rec)}
		</span>
	);
}

function ReconView(props: { recon: Recon | null }): React.ReactElement {
	const recon = props.recon;
	if (!recon) return <p className="empty">Run a tool above. Start with “① Load demo edits”, then ② → ⑥.</p>;

	if (recon.kind === 'merge') {
		return (
			<div>
				<p>
					<code>mergeLedgers(A, B)</code> → {recon.timeline.length} records in chronological order.{' '}
					{recon.pairs.length > 0 ? (
						<strong className="danger">{recon.pairs.length} conflict pair(s) detected.</strong>
					) : (
						<strong className="ok">No conflicts.</strong>
					)}
				</p>
				<ol className="timeline">
					{recon.timeline.map((r) => (
						<li key={r.id} className={recon.conflictIds.has(r.id) ? 'conflict' : ''}>
							<RecordChip rec={r} warn={recon.conflictIds.has(r.id)} />
							{recon.conflictIds.has(r.id) && <span className="tag">⚠ conflict</span>}
						</li>
					))}
				</ol>
				<p className="muted">
					The Result editor shows the naive union (both edits applied). Use ③ to drop one side or ④ to keep both.
				</p>
			</div>
		);
	}

	if (recon.kind === 'resolve') {
		return (
			<div>
				<p>
					<code>resolveConflicts</code> · strategy <strong>{recon.strategy}</strong> → kept {recon.kept.length}, dropped{' '}
					{recon.dropped.length}.
				</p>
				<div className="cols">
					<div>
						<h4 className="ok">Kept</h4>
						<ul className="plain">
							{recon.kept.map((r) => (
								<li key={r.id}>
									<RecordChip rec={r} />
								</li>
							))}
						</ul>
					</div>
					<div>
						<h4 className="danger">Dropped</h4>
						{recon.dropped.length === 0 ? (
							<p className="muted">none</p>
						) : (
							<ul className="plain">
								{recon.dropped.map((d) => (
									<li key={d.record.id}>
										<RecordChip rec={d.record} warn /> <span className="muted">lost to</span>{' '}
										<code>{shortId(d.conflictsWith.id)}</code>
									</li>
								))}
							</ul>
						)}
					</div>
				</div>
			</div>
		);
	}

	if (recon.kind === 'rebase') {
		return (
			<div>
				<p>
					<code>rebaseRecords(B, over: A, base)</code> → rebased {recon.rebased.length}, failed {recon.failed.length}. The
					Result keeps <strong>both</strong> sides: A unchanged, B transformed on top.
				</p>
				<div className="cols">
					<div>
						<h4 className="ok">Rebased</h4>
						<ul className="plain">
							{recon.rebased.map((r) => (
								<li key={r.id}>
									<RecordChip rec={r} />
								</li>
							))}
						</ul>
					</div>
					<div>
						<h4 className="danger">Failed (conservative bail)</h4>
						{recon.failed.length === 0 ? (
							<p className="muted">none — all edits transformed cleanly</p>
						) : (
							<ul className="plain">
								{recon.failed.map((f) => (
									<li key={f.record.id}>
										<RecordChip rec={f.record} warn /> <span className="muted">{f.reason}</span>
									</li>
								))}
							</ul>
						)}
					</div>
				</div>
			</div>
		);
	}

	if (recon.kind === 'diff') {
		return (
			<div>
				<p>
					<code>diffLedgers(A, merged)</code> — Client A already has <strong>{recon.common.length}</strong> shared record(s)
					and needs to pull <strong className="danger">{recon.onlyInB.length}</strong>.
				</p>
				<h4>To pull into A</h4>
				{recon.onlyInB.length === 0 ? (
					<p className="muted">A is up to date.</p>
				) : (
					<ul className="plain">
						{recon.onlyInB.map((r) => (
							<li key={r.id}>
								<RecordChip rec={r} />
							</li>
						))}
					</ul>
				)}
			</div>
		);
	}

	// serialize
	return (
		<div>
			<p>
				<code>ledger.serialize()</code> → {recon.bytes} bytes, then <code>TransactionLedger.deserialize()</code> →{' '}
				{recon.count} record(s). Replaying the round-tripped ledger reproduces the document{' '}
				{recon.equal ? <strong className="ok">identically ✓</strong> : <strong className="danger">— MISMATCH ✗</strong>}.
			</p>
			<pre className="sample">{recon.sample}…</pre>
		</div>
	);
}
