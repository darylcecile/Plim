import * as React from 'react';

export type MentionUser = {
	id: string;
	name: string;
	handle: string;
	avatar: string; // emoji or single-letter avatar
	role: string;
};

const USERS: MentionUser[] = [
	{ id: 'u1', name: 'Alice Anderson', handle: 'alice', avatar: '🦊', role: 'Engineering' },
	{ id: 'u2', name: 'Ben Becker', handle: 'ben', avatar: '🐻', role: 'Design' },
	{ id: 'u3', name: 'Carla Cruz', handle: 'carla', avatar: '🐱', role: 'Product' },
	{ id: 'u4', name: 'Diego Diaz', handle: 'diego', avatar: '🦅', role: 'Engineering' },
	{ id: 'u5', name: 'Elena Eriksen', handle: 'elena', avatar: '🐺', role: 'Marketing' },
	{ id: 'u6', name: 'Farah Fadel', handle: 'farah', avatar: '🐯', role: 'Operations' },
	{ id: 'u7', name: 'Gabriel Gomes', handle: 'gabriel', avatar: '🦁', role: 'Engineering' },
	{ id: 'u8', name: 'Hana Hashimoto', handle: 'hana', avatar: '🐰', role: 'Research' },
];

export type MentionMenuProps = {
	onSelect: (user: MentionUser | null) => void;
};

export function MentionMenu({ onSelect }: MentionMenuProps) {
	const [query, setQuery] = React.useState('');
	const [active, setActive] = React.useState(0);
	const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

	const filtered = React.useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return USERS;
		return USERS.filter(
			(u) => u.name.toLowerCase().includes(q) || u.handle.toLowerCase().includes(q) || u.role.toLowerCase().includes(q)
		);
	}, [query]);

	React.useEffect(() => setActive(0), [query]);

	React.useEffect(() => {
		const el = itemRefs.current[active];
		if (el) el.scrollIntoView({ block: 'nearest' });
	}, [active]);

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
			if (ev.key === 'Enter' || ev.key === 'Tab') {
				ev.preventDefault();
				ev.stopPropagation();
				const u = filtered[active];
				if (u) onSelect(u);
				else onSelect(null);
				return;
			}
			if (ev.key === ' ') {
				// Space dismisses without selecting (matches the action's cancellationTriggers).
				ev.preventDefault();
				ev.stopPropagation();
				onSelect(null);
				return;
			}
			if (ev.key === 'Backspace') {
				if (query.length === 0) {
					// Backspace on empty filter — close the menu and let the user
					// remove the trigger '@' themselves.
					ev.preventDefault();
					ev.stopPropagation();
					onSelect(null);
					return;
				}
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
	}, [active, filtered, onSelect, query]);

	return (
		<div className="mention-menu" role="listbox">
			<div className="mention-menu-header">{query ? `Filtering: "${query}"` : 'Mention a person'}</div>
			<div className="mention-menu-list">
				{filtered.length === 0 ? (
					<div className="mention-menu-empty">No people match "{query}"</div>
				) : (
					filtered.map((u, i) => (
						<button
							key={u.id}
							ref={(el) => {
								itemRefs.current[i] = el;
							}}
							className={`mention-menu-item${i === active ? ' active' : ''}`}
							onMouseDown={(e) => {
								e.preventDefault();
								onSelect(u);
							}}
							onMouseEnter={() => setActive(i)}
						>
							<span className="mention-avatar">{u.avatar}</span>
							<span className="mention-primary">
								<span className="mention-name">{u.name}</span>
								<span className="mention-handle">@{u.handle}</span>
							</span>
							<span className="mention-role">{u.role}</span>
						</button>
					))
				)}
			</div>
		</div>
	);
}
