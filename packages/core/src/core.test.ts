import { describe, expect, it } from 'vitest';
import { PlimDriver, Snapshot, createBlock, createContent, defineAction, defineBlock, defineExtension, operationApply, triggers } from './index.ts';

describe('@plim/core', () => {
  it('defines blocks, actions, triggers, and extension contributions', () => {
    const paragraph = defineBlock({ name: 'paragraph' });
    const action = defineAction('slashCommand', {
      trigger: triggers.keyboard.character('/'),
      triggerValidationRules: ({ or }) => or(['startOfBlock', 'precededByWhitespace']),
      perform: async (_state, ctx) => ctx.triggerAsyncEvent('showSlashCommandMenu'),
      priority: 10
    });
    const extension = defineExtension(() => ({
      name: 'starter',
      registeredBlocks: [paragraph],
      registeredActions: [action]
    }));
    const driver = new PlimDriver({ extensions: [extension] });
    const handle = {
      isReady: false,
      getState: () => ({
        content: createContent(),
        selection: null,
        readonly: false,
        version: 0
      })
    };

    expect(driver.getRegisteredBlocks(handle)).toEqual([paragraph]);
    expect(driver.getRegisteredActions(handle)[0]?.name).toBe('slashCommand');
  });

  it('serializes snapshots without sharing mutable state', () => {
    const state = {
      content: createContent([createBlock('paragraph', 'Hello')], 'Doc'),
      selection: null,
      readonly: false,
      version: 1
    };
    const snapshot = new Snapshot(state);
    state.content.blocks[0]!.text = 'Changed';

    expect(Snapshot.deserialize(snapshot.serialize()).state.content.blocks[0]?.text).toBe('Hello');
  });

  it('tracks history state changes', () => {
    const driver = new PlimDriver();
    const history = driver.getHistory();
    const states: boolean[] = [];
    history.attachRestore(() => undefined);
    history.onChange((state) => states.push(state.canUndo));
    driver._recordTransaction({
      id: 't1',
      timestamp: 1,
      operations: [],
      before: {
        content: createContent(),
        selection: null,
        readonly: false,
        version: 0
      },
      after: {
        content: createContent([createBlock('paragraph', 'Next')]),
        selection: null,
        readonly: false,
        version: 1
      }
    });

    expect(history.canUndo).toBe(true);
    expect(states).toEqual([false, true]);
  });

  it('moves blocks while preserving block identity', () => {
    const first = createBlock('paragraph', 'First');
    const second = createBlock('paragraph', 'Second');
    const third = createBlock('paragraph', 'Third');
    const applied = operationApply(createContent([first, second, third]), [{ op: 'moveBlock', blockId: first.id, afterBlockId: second.id }], null);

    expect(applied.content.blocks.map((block) => block.id)).toEqual([second.id, first.id, third.id]);
    expect(applied.content.blocks[1]).toMatchObject({ id: first.id, text: 'First' });
  });
});
