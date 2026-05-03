import * as React from 'react';

type Item = {
	id: string;
	label: string;
	hint: string;
	icon: string;
	keywords: string[];
};

const ITEMS: Item[] = [
	{ id: 'paragraph', label: 'Text', hint: 'Plain text paragraph', icon: '¶', keywords: ['text', 'paragraph', 'plain'] },
	{ id: 'h1', label: 'Heading 1', hint: 'Big section heading', icon: 'H1', keywords: ['h1', 'heading', 'big'] },
	{ id: 'h2', label: 'Heading 2', hint: 'Medium section heading', icon: 'H2', keywords: ['h2', 'heading'] },
	{ id: 'h3', label: 'Heading 3', hint: 'Small section heading', icon: 'H3', keywords: ['h3', 'heading'] },
	{ id: 'bulleted', label: 'Bulleted list', hint: 'A simple bulleted list', icon: '•', keywords: ['bullet', 'list', 'unordered'] },
	{ id: 'numbered', label: 'Numbered list', hint: 'An ordered list', icon: '1.', keywords: ['number', 'numbered', 'list'] },
	{ id: 'todo', label: 'To-do list', hint: 'Track tasks', icon: '☐', keywords: ['todo', 'task', 'check'] },
	{ id: 'toggle', label: 'Toggle list', hint: 'Collapsible content', icon: '▸', keywords: ['toggle', 'collapse'] },
	{ id: 'quote', label: 'Quote', hint: 'Capture a quote', icon: '❝', keywords: ['quote', 'callout'] },
	{ id: 'code', label: 'Code', hint: 'Block of code', icon: '</>', keywords: ['code', 'snippet'] },
	{ id: 'divider', label: 'Divider', hint: 'Visual divider', icon: '—', keywords: ['divider', 'hr', 'rule'] },
	{ id: 'image', label: 'Image', hint: 'Embed an image by URL', icon: '🖼', keywords: ['image', 'picture', 'photo', 'img'] },
	{ id: 'embed', label: 'Embed', hint: 'Embed a URL via iframe', icon: '🔗', keywords: ['embed', 'iframe', 'url', 'link'] },
	{ id: 'raw_html', label: 'Raw HTML', hint: 'Sandboxed HTML snippet', icon: '</>', keywords: ['html', 'raw', 'embed'] },
	{ id: 'table', label: 'Table', hint: 'Simple data table', icon: '⊞', keywords: ['table', 'grid', 'rows'] },
];

export type SlashMenuProps = {
	x: number;
	y: number;
	onSelect: (id: string | null) => void;
};

export function SlashMenu({ x, y, onSelect }: SlashMenuProps) {
	const [query, setQuery] = React.useState('');
	const [active, setActive] = React.useState(0);

	const filtered = React.useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return ITEMS;
		return ITEMS.filter((i) => i.label.toLowerCase().includes(q) || i.keywords.some((k) => k.includes(q)));
	}, [query]);

	React.useEffect(() => setActive(0), [query]);

	React.useEffect(() => {
		function onKey(ev: KeyboardEvent) {
			if (ev.key === 'Escape') {
				ev.preventDefault();
				ev.stopPropagation();
				onSelect(null);
				return;
			}
			if (ev.key === 'ArrowDown') {
				ev.preventDefault();
				ev.stopPropagation();
				setActive((a) => Math.min(filtered.length - 1, a + 1));
				return;
			}
			if (ev.key === 'ArrowUp') {
				ev.preventDefault();
				ev.stopPropagation();
				setActive((a) => Math.max(0, a - 1));
				return;
			}
			if (ev.key === 'Enter') {
				ev.preventDefault();
				ev.stopPropagation();
				const it = filtered[active];
				if (it) onSelect(it.id);
				else onSelect(null);
				return;
			}
			if (ev.key === 'Backspace') {
				ev.preventDefault();
				ev.stopPropagation();
				setQuery((q) => q.slice(0, -1));
				return;
			}
			if (ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey) {
				ev.preventDefault();
				ev.stopPropagation();
				setQuery((q) => q + ev.key);
			}
		}
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	}, [active, filtered, onSelect]);

	return (
		<div className="slash-menu" style={{ left: x, top: y }} role="listbox">
			<div className="slash-menu-header">{query ? `Filtering: "${query}"` : 'Basic blocks'}</div>
			<div className="slash-menu-list">
				{filtered.length === 0 ? (
					<div className="slash-menu-empty">No results</div>
				) : (
					filtered.map((it, i) => (
						<button
							key={it.id}
							className={`slash-menu-item${i === active ? ' active' : ''}`}
							onMouseDown={(e) => {
								e.preventDefault();
								onSelect(it.id);
							}}
							onMouseEnter={() => setActive(i)}
						>
							<span className="slash-icon">{it.icon}</span>
							<span className="slash-label">{it.label}</span>
							<span className="slash-hint">{it.hint}</span>
						</button>
					))
				)}
			</div>
		</div>
	);
}
