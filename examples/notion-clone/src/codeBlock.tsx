import { defineBlock, type EditorHandle } from '@plim/core';
import { highlight } from 'sugar-high';
import * as presets from 'sugar-high/presets';

// ──────────────────────────────────────────────────────────────────────────
// Code block with sugar-high syntax highlighting
// ──────────────────────────────────────────────────────────────────────────
//
// A custom block descriptor named `code` — overrides the editor's built-in
// code-block render path because `view.ts:renderBlock` checks registered
// descriptors before falling through to the built-in switch.
//
// The descriptor's `toDOM` does NOT use `payload.content` (the editor's
// pre-rendered text spans). Instead it asks sugar-high to tokenize
// `payload.textContent` into HTML and mounts that as the inner content of
// the editor's contract-required `[data-block-content]` element. Because
// sugar-high preserves every input character verbatim (each consumed run
// emerges as a `<span>` with its original text), the wrapper's combined
// textContent equals the input — so the editor's TreeWalker-based
// selection-restore (which walks text descendants of `[data-block-content]`
// by offset) Just Works across re-tokenizations.
//
// Languages:
//  - js/ts/jsx/tsx/json: pass through `highlight(text)` (sugar-high is
//    JS-flavoured by default and tokenizes these well enough).
//  - css/rust/python/c/go/java: use `sugar-high/presets`.
//  - html/markdown/bash/plain: emit unstyled (sugar-high default is
//    misleading for these, plain text is more honest).
//
// The language picker (top-right of the block) writes `attrs.language`,
// which markdown serialization picks up as the fence label. Selection is
// preserved across language switches because `setBlockAttrs` doesn't touch
// `node.text`.

type LangId =
	| 'plain'
	| 'javascript'
	| 'typescript'
	| 'jsx'
	| 'tsx'
	| 'json'
	| 'html'
	| 'css'
	| 'markdown'
	| 'python'
	| 'rust'
	| 'bash';

const LANG_LABELS: Record<LangId, string> = {
	plain: 'Plain Text',
	javascript: 'JavaScript',
	typescript: 'TypeScript',
	jsx: 'JSX',
	tsx: 'TSX',
	json: 'JSON',
	html: 'HTML',
	css: 'CSS',
	markdown: 'Markdown',
	python: 'Python',
	rust: 'Rust',
	bash: 'Bash',
};

const LANG_ORDER: LangId[] = [
	'plain',
	'javascript',
	'typescript',
	'jsx',
	'tsx',
	'json',
	'html',
	'css',
	'markdown',
	'python',
	'rust',
	'bash',
];

// Map a language id to a sugar-high invocation. Returns `null` to mean
// "render as plain text" (no tokenization). The default (no preset) is
// already JS-flavoured; for JS/TS/JSX/TSX/JSON we just use that path.
function highlightFor(lang: LangId, code: string): string | null {
	switch (lang) {
		case 'plain':
		case 'html':
		case 'markdown':
		case 'bash':
			return null;
		case 'css':
			return highlight(code, presets.css);
		case 'rust':
			return highlight(code, presets.rust);
		case 'python':
			return highlight(code, presets.python);
		default:
			return highlight(code);
	}
}

// Per-block highlight memo. Sugar-high is fast (well under 1ms for typical
// blocks) but unrelated transactions (typing in another block) trigger
// re-renders of every block — caching by block id avoids the redundant
// tokenization work on those.
const HIGHLIGHT_CACHE = new Map<string, { text: string; lang: LangId; html: string }>();

function tokenize(blockId: string, text: string, lang: LangId): string {
	const cached = HIGHLIGHT_CACHE.get(blockId);
	if (cached && cached.text === text && cached.lang === lang) return cached.html;
	const html = highlightFor(lang, text);
	const result = html ?? escapeHtml(text);
	HIGHLIGHT_CACHE.set(blockId, { text, lang, html: result });
	return result;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

// Walk the editor doc to find a block path by id. Block ids are stable
// across transactions but a block's path is not (drags / splits move
// blocks around), so we look it up at commit time.
function findPathForBlockId(editor: EditorHandle, id: string): number[] | null {
	type ChildNode = { id: string; children?: ChildNode[] };
	const walk = (children: ChildNode[], parent: number[]): number[] | null => {
		for (let i = 0; i < children.length; i++) {
			const c = children[i];
			if (!c) continue;
			if (c.id === id) return [...parent, i];
			if (c.children) {
				const found = walk(c.children, [...parent, i]);
				if (found) return found;
			}
		}
		return null;
	};
	return walk(editor.getState().doc.children as ChildNode[], []);
}

function setLanguage(editor: EditorHandle, blockId: string, lang: LangId) {
	const path = findPathForBlockId(editor, blockId);
	if (!path) return;
	const tx = editor.createTransaction();
	tx.setBlockAttrs(path, { language: lang });
	tx.commit();
}

// Build the language picker (a single-shot dropdown). `contenteditable=false`
// throughout so the picker chrome doesn't enter the editor's text mapping;
// `mousedown` handlers preventDefault to keep selection inside the code
// block stable while the menu opens. A capture-phase document listener
// closes the menu on outside clicks.
function buildPicker(currentLang: LangId, onChoose: (lang: LangId) => void): HTMLElement {
	const root = document.createElement('div');
	root.className = 'plim-code-lang';
	root.setAttribute('contenteditable', 'false');

	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'plim-code-lang-button';
	button.textContent = LANG_LABELS[currentLang];

	const menu = document.createElement('ul');
	menu.className = 'plim-code-lang-menu';
	menu.hidden = true;

	for (const id of LANG_ORDER) {
		const li = document.createElement('li');
		li.textContent = LANG_LABELS[id];
		li.setAttribute('data-lang', id);
		if (id === currentLang) li.setAttribute('aria-current', 'true');
		// `mousedown` (not `click`) so we beat the editor's selection-on-mousedown
		// handler and keep the caret stable. preventDefault on the event would
		// also block focus changes — we want that.
		li.addEventListener('mousedown', (e) => {
			e.preventDefault();
			e.stopPropagation();
			menu.hidden = true;
			onChoose(id);
		});
		menu.appendChild(li);
	}

	let outsideHandler: ((e: MouseEvent) => void) | null = null;
	const closeMenu = () => {
		menu.hidden = true;
		if (outsideHandler) {
			document.removeEventListener('mousedown', outsideHandler, true);
			outsideHandler = null;
		}
	};
	const openMenu = () => {
		menu.hidden = false;
		outsideHandler = (e: MouseEvent) => {
			if (!root.contains(e.target as Node)) closeMenu();
		};
		document.addEventListener('mousedown', outsideHandler, true);
	};

	button.addEventListener('mousedown', (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (menu.hidden) openMenu();
		else closeMenu();
	});

	root.appendChild(button);
	root.appendChild(menu);
	return root;
}

export const codeBlock = defineBlock((editor) => ({
	name: 'code',
	type: 'standalone',
	// Match the built-in `codeBlock` metadata so behaviour is identical
	// outside of rendering.
	supportsDecoration: false,
	// Plain Enter inserts a literal `\n` rather than splitting the block,
	// so users can compose multi-line code without each Enter creating a
	// fresh code block. ArrowDown / ArrowRight at end of the last line
	// exits to the next block (or auto-creates a trailing paragraph if
	// none exists) — see `multilineText` handling in the editor view.
	multilineText: true,
	// Markdown round-trip: emit a fenced block with the language id as the
	// fence info string. Built-in code rendering already handles this, but
	// since we override the descriptor we must restore the behaviour.
	toMarkdown: (payload) => {
		const lang = String(payload.attrs.language ?? '');
		const fence = '```';
		return [`${fence}${lang}\n${payload.textContent}\n${fence}`];
	},
	toDOM: (payload) => {
		const lang = ((payload.attrs.language as LangId | undefined) ?? 'plain') as LangId;
		const validLang: LangId = LANG_ORDER.includes(lang) ? lang : 'plain';

		// Outer wrapper: positioned `relative` so the picker can park itself
		// in the top-right via absolute positioning.
		const shell = document.createElement('div');
		shell.className = 'plim-code-shell';
		shell.setAttribute('data-language', validLang);

		const pre = document.createElement('pre');
		pre.className = 'plim-code-pre';

		const code = document.createElement('code');
		code.setAttribute('data-block-content', 'true');
		code.className = 'plim-code-content';
		// Tokenize via sugar-high. Result is HTML already, so we
		// `innerHTML =` it directly. Sugar-high never emits user text as
		// HTML attribute values — only as text nodes inside spans — so the
		// content of `payload.textContent` cannot escape the parser.
		code.innerHTML = tokenize(payload.id, payload.textContent, validLang);
		pre.appendChild(code);

		const picker = buildPicker(validLang, (next) => setLanguage(editor, payload.id, next));

		shell.appendChild(pre);
		shell.appendChild(picker);
		return shell;
	},
}));
