import { describe, expect, it } from 'vitest';
import { contentFromMarkdown } from './index.ts';

describe('@plim/markdown', () => {
  it('turns markdown lines into Plim block content', () => {
    const content = contentFromMarkdown('# Project notes', '', 'A **bold** plan', '- First task', '> Useful quote', '---');

    expect(content.title).toBe('Project notes');
    expect(content.blocks.map((block) => block.type)).toEqual(['paragraph', 'bulletedList', 'quote', 'divider']);
    expect(content.blocks[0]?.text).toBe('A bold plan');
    expect(content.blocks[0]?.marks).toEqual([{ mark: 'bold', from: 2, to: 6 }]);
  });
});
