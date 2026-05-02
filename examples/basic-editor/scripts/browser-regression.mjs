import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(__dirname, '..');
const port = Number(process.env.PLIM_EXAMPLE_PORT ?? 5173);
const cdpPort = Number(process.env.PLIM_CHROME_CDP_PORT ?? 9223);
const appUrl = `http://127.0.0.1:${port}/`;
const chromeBinary = process.env.CHROME_BIN ?? defaultChromeBinary();
const verbose = process.env.PLIM_BROWSER_REGRESSION_VERBOSE === '1';
const results = [];

let vite;
let chrome;
let chromeProfile;

try {
  await startVite();
  await startChrome();
  await runTests();
  console.log(`Browser regression checks passed:\n- ${results.join('\n- ')}`);
} finally {
  await stopProcess(chrome);
  await stopProcess(vite);
  if (chromeProfile) await rm(chromeProfile, { recursive: true, force: true });
}

async function runTests() {
  await testStep('initial semantics', testInitialSemantics);
  await testStep('keyboard typing', testKeyboardTyping);
  await testStep('backspace boundaries', testBackspaceBoundaries);
  await testStep('markdown transforms', testMarkdownTransforms);
  await testStep('markdown non-triggers', testMarkdownNonTriggers);
  await testStep('text persistence', testTextEditingAndPersistence);
  await testStep('enter behavior', testEnterAndShiftEnter);
  await testStep('arrow navigation', testArrowNavigation);
  await testStep('slash menu', testSlashMenu);
  await testStep('to-do text editing', testTodoTextEditing);
  await testStep('todo/insertion controls', testTodoAndInsertionControls);
  await testStep('reordering', testReordering);
}

async function testStep(label, test) {
  if (verbose) console.error(`Running ${label}...`);
  await test();
}

async function testInitialSemantics() {
  const page = await openPage('initial semantics');
  try {
    const semantics = await page.evaluate(`(() => ({
      blocks: blockSnapshot(),
      editables: [...document.querySelectorAll('[data-plim-editable="true"]')].map(el => ({
        role: el.getAttribute('role'),
        multiline: el.getAttribute('aria-multiline'),
        roleDescription: el.getAttribute('aria-roledescription'),
        whiteSpace: getComputedStyle(el).whiteSpace,
        wordBreak: getComputedStyle(el).wordBreak
      }))
    }))()`);
    assert(semantics.blocks.map(block => block.type).join(',') === 'heading_1,paragraph,to_do', 'seeded document should render heading, paragraph, to-do', semantics.blocks);
    assert(semantics.editables.every(item => item.role === 'textbox' && item.multiline === 'true'), 'editable leaves should be accessible textboxes', semantics.editables);
    assert(semantics.editables.every(item => item.whiteSpace === 'break-spaces'), 'editable leaves should preserve Notion-like spaces', semantics.editables);
    results.push('initial document semantics');
  } finally {
    await page.close();
  }
}

async function testKeyboardTyping() {
  const page = await openPage('keyboard typing');
  try {
    await createEmptyParagraphAfterSecondBlock(page);
    await typeText(page, 'typed words');
    const selected = (await blocks(page)).find(block => block.selected);
    assert(selected?.type === 'paragraph', 'typed text should keep the active block as a paragraph', selected);
    assert(selected.text === 'typed words', 'typed characters should appear through browser key events', selected);
    results.push('keyboard character typing');
  } finally {
    await page.close();
  }
}

async function testBackspaceBoundaries() {
  const mergePage = await openPage('backspace merge');
  try {
    const previousText = (await blocks(mergePage))[0].text;
    await setEditableTextAndFocus(mergePage, 1, 'joined', 0);
    await mergePage.key('Backspace', 'Backspace', 8);
    await wait(700);
    const snapshot = await blocks(mergePage);
    const active = await activeInfo(mergePage);
    assert(snapshot.length === 2, 'Backspace at the start of a non-empty block should remove the merged block', { snapshot, active });
    assert(snapshot[0].type === 'heading_1' && snapshot[0].text === `${previousText}joined` && snapshot[0].selected, 'Backspace should merge current text into the previous text block', { snapshot, active });
    assert(active.type === 'heading_1' && active.offset === previousText.length, 'Backspace merge should leave caret at the merge boundary', active);
  } finally {
    await mergePage.close();
  }

  const deletePage = await openPage('backspace delete empty block');
  try {
    const previousText = (await blocks(deletePage))[0].text;
    await setEditableTextAndFocus(deletePage, 1, '', 0);
    await deletePage.key('Backspace', 'Backspace', 8);
    await wait(700);
    const snapshot = await blocks(deletePage);
    const active = await activeInfo(deletePage);
    assert(snapshot.length === 2, 'Backspace at the start of an empty block should delete that block', snapshot);
    assert(snapshot[0].type === 'heading_1' && snapshot[0].text === previousText && snapshot[0].selected, 'Backspace delete should focus the previous block', { snapshot, active });
    assert(active.type === 'heading_1' && active.offset === previousText.length, 'Backspace delete should leave caret at the previous block end', active);
  } finally {
    await deletePage.close();
  }

  results.push('Backspace merge/delete at block start');
}

async function testMarkdownTransforms() {
  for (const [marker, expectedType] of [['# ', 'heading_1'], ['## ', 'heading_2'], ['### ', 'heading_3'], ['[] ', 'to_do'], ['[x] ', 'to_do'], ['- ', 'bulleted_list_item'], ['1. ', 'numbered_list_item'], ['" ', 'quote']]) {
    const page = await openPage(`markdown ${JSON.stringify(marker)}`);
    try {
      await createEmptyParagraphAfterSecondBlock(page);
      await typeText(page, marker);
      const snapshot = await blocks(page);
      const selected = snapshot.find(block => block.selected);
      assert(selected?.type === expectedType, `markdown ${JSON.stringify(marker)} should create ${expectedType}`, snapshot);
      assert(selected.text === '', `markdown ${JSON.stringify(marker)} should remove marker text`, snapshot);
      if (marker === '[x] ') {
        const checked = await page.evaluate(`document.querySelector('.plim-example-block.is-selected input[type="checkbox"]')?.checked`);
        assert(checked === true, '[x] should create a checked to-do', { checked, snapshot });
      }
      results.push(`markdown ${JSON.stringify(marker)} -> ${expectedType}`);
    } finally {
      await page.close();
    }
  }
}

async function testMarkdownNonTriggers() {
  for (const text of ['hello ## ', '#### ', '#x ', '##x ', '[]x ']) {
    const page = await openPage(`markdown non-trigger ${JSON.stringify(text)}`);
    try {
      await createEmptyParagraphAfterSecondBlock(page);
      await typeText(page, text);
      const selected = (await blocks(page)).find(block => block.selected);
      assert(selected?.type === 'paragraph', `non-trigger ${JSON.stringify(text)} should stay paragraph`, selected);
      assert(selected.text === text, `non-trigger ${JSON.stringify(text)} should preserve text`, selected);
      results.push(`markdown non-trigger ${JSON.stringify(text)}`);
    } finally {
      await page.close();
    }
  }
}

async function testTextEditingAndPersistence() {
  const page = await openPage('text editing persistence');
  try {
    await page.evaluate(`(() => {
      const title = document.querySelector('.page-title');
      title.textContent = 'Persisted title';
      title.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      const editable = document.querySelectorAll('[data-plim-editable="true"]')[1];
      editable.textContent = 'Persisted paragraph';
      editable.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      return true;
    })()`);
    await wait(300);
    await page.evaluate(`document.querySelector('#save-snapshot').click()`);
    await wait(300);
    await page.reload();
    await page.waitForEditor();
    const restored = await page.evaluate(`(() => ({
      title: document.querySelector('.page-title')?.textContent,
      paragraph: document.querySelectorAll('[data-plim-editable="true"]')[1]?.textContent
    }))()`);
    assert(restored.title === 'Persisted title', 'page title should persist after save/reload', restored);
    assert(restored.paragraph === 'Persisted paragraph', 'paragraph text should persist after save/reload', restored);
    results.push('text editing and local persistence');
  } finally {
    await page.close();
  }
}

async function testEnterAndShiftEnter() {
  const page = await openPage('enter behavior');
  try {
    await setEditableTextAndFocus(page, 1, 'first second', 'first '.length);
    await page.key('Enter', 'Enter', 13);
    await wait(500);
    let snapshot = await blocks(page);
    let active = await activeInfo(page);
    assert(snapshot.map(block => block.type).slice(0, 4).join(',') === 'heading_1,paragraph,paragraph,to_do', 'Enter should insert a paragraph immediately below current block', snapshot);
    assert(snapshot[1].text === 'first ' && snapshot[2].text === 'second' && snapshot[2].selected, 'Enter should split block text at the caret and focus the inserted block', { snapshot, active });
    assert(active.type === 'paragraph' && active.offset === 0, 'Enter split should place the caret at the start of the continuation block', active);

    await setEditableTextAndFocus(page, 2, 'line one', 'line one'.length);
    await page.key('Enter', 'Enter', 13);
    await wait(500);
    snapshot = await blocks(page);
    assert(snapshot[2].text === 'line one' && snapshot[3].text === '' && snapshot[3].selected, 'Enter at block end should create and focus an empty continuation paragraph', snapshot);

    await setEditableTextAndFocus(page, 3, 'first', 'first'.length);
    await page.key('Enter', 'Enter', 13, { shiftKey: true });
    await page.insert('second');
    await wait(300);
    active = await activeInfo(page);
    assert(active.type === 'paragraph' && active.text === 'first\nsecond', 'Shift+Enter should create a line break without a new block', active);
    results.push('Enter split and Shift+Enter behavior');
  } finally {
    await page.close();
  }
}

async function testArrowNavigation() {
  const page = await openPage('arrow navigation');
  try {
    await setEditableTextAndFocus(page, 1, 'short text', 5);
    await page.key('ArrowDown', 'ArrowDown', 40);
    await wait(450);
    let active = await activeInfo(page);
    assert(active.type === 'to_do' && active.selected === true, 'ArrowDown from single-line block should move to next block', active);

    await setEditableTextAndFocus(page, 2, 'todo', 2);
    await page.key('ArrowUp', 'ArrowUp', 38);
    await wait(450);
    active = await activeInfo(page);
    assert(active.type === 'paragraph' && active.selected === true, 'ArrowUp from single-line block should move to previous block', active);

    await setEditableTextAndFocus(page, 1, 'first visual line\nsecond visual line', 5);
    await page.key('ArrowDown', 'ArrowDown', 40);
    await wait(450);
    active = await activeInfo(page);
    assert(active.type === 'paragraph', 'ArrowDown before the last visual line should stay in the same block', active);

    await setEditableTextAndFocus(page, 1, 'first visual line\nsecond visual line', 'first visual line\nsecond visual line'.length);
    await page.key('ArrowDown', 'ArrowDown', 40);
    await wait(450);
    active = await activeInfo(page);
    assert(active.type === 'to_do', 'ArrowDown on the last visual line should move to the next block', active);

    await setEditableTextAndFocus(page, 1, 'wrapped line '.repeat(18), 8);
    await page.key('ArrowDown', 'ArrowDown', 40);
    await wait(450);
    active = await activeInfo(page);
    assert(active.type === 'paragraph', 'ArrowDown in a wrapped block before the last visual line should stay in the block', active);

    await setEditableTextAndFocus(page, 1, 'left right', 0);
    await page.key('ArrowLeft', 'ArrowLeft', 37);
    await wait(450);
    active = await activeInfo(page);
    assert(active.type === 'heading_1', 'ArrowLeft at text start should move to previous block', active);

    await setEditableTextAndFocus(page, 1, 'left right', 'left right'.length);
    await page.key('ArrowRight', 'ArrowRight', 39);
    await wait(450);
    active = await activeInfo(page);
    assert(active.type === 'to_do', 'ArrowRight at text end should move to next block', active);
    results.push('block arrow navigation');
  } finally {
    await page.close();
  }
}

async function testSlashMenu() {
  const page = await openPage('slash menu');
  try {
    await createEmptyParagraphAfterSecondBlock(page);
    await typeText(page, '/h');
    let menu = await slashMenuState(page);
    assert(menu.open && menu.role === 'listbox' && menu.items.length >= 3, 'slash menu should open for /h', menu);
    assert(menu.items[0].selected === 'true', 'slash menu should start with first item active', menu);

    await page.key('ArrowDown', 'ArrowDown', 40);
    await wait(100);
    menu = await slashMenuState(page);
    assert(menu.items[1].selected === 'true', 'ArrowDown should move slash active item', menu);

    await page.key('ArrowUp', 'ArrowUp', 38);
    await wait(100);
    menu = await slashMenuState(page);
    assert(menu.items[0].selected === 'true', 'ArrowUp should move slash active item back', menu);

    await page.key('End', 'End', 35);
    await wait(100);
    menu = await slashMenuState(page);
    assert(menu.items.at(-1)?.selected === 'true', 'End should move slash active item to last option', menu);

    await page.key('Home', 'Home', 36);
    await wait(100);
    menu = await slashMenuState(page);
    assert(menu.items[0].selected === 'true', 'Home should move slash active item to first option', menu);

    await page.key('Escape', 'Escape', 27);
    await wait(150);
    menu = await slashMenuState(page);
    assert(menu.open === false, 'Escape should close slash menu', menu);

    await setEditableTextAndFocus(page, 2, '', 0);
    await typeText(page, '/h');
    await page.key('ArrowDown', 'ArrowDown', 40);
    menu = await slashMenuState(page);
    const expectedType = typeForSlashLabel(menu.items.find(item => item.selected === 'true').text);
    await page.key('Tab', 'Tab', 9);
    await wait(700);
    let snapshot = await blocks(page);
    let active = await activeInfo(page);
    assert(snapshot.some(block => block.type === expectedType && block.selected), 'Tab should select active slash item and focus inserted block', { expectedType, snapshot, active });

    await setEditableTextAndFocus(page, snapshot.findIndex(block => block.selected), '', 0);
    await typeText(page, '/to');
    await page.evaluate(`document.querySelector('#slash-menu button')?.click()`);
    await wait(700);
    snapshot = await blocks(page);
    assert(snapshot.some(block => block.type === 'to_do' && block.text === 'New to-do' && block.selected), 'Clicking slash item should insert and select to-do', snapshot);
    results.push('slash menu keyboard, escape, tab, click');
  } finally {
    await page.close();
  }
}

async function testTodoTextEditing() {
  const page = await openPage('to-do text editing');
  try {
    const textSelector = '.plim-example-block[data-plim-block-type="to_do"] [data-plim-editable="true"]';
    const checkboxSelector = '.plim-example-block[data-plim-block-type="to_do"] input[type="checkbox"]';

    await page.click(textSelector);
    await wait(200);
    let state = await page.evaluate(`(() => ({
      checked: document.querySelector(${JSON.stringify(checkboxSelector)})?.checked,
      activeType: document.activeElement?.closest?.('.plim-example-block')?.dataset.plimBlockType,
      activeEditable: document.activeElement?.matches?.('[data-plim-editable="true"]') ?? false
    }))()`);
    assert(state.checked === false, 'clicking to-do text should not toggle the checkbox', state);
    assert(state.activeType === 'to_do' && state.activeEditable === true, 'clicking to-do text should focus the editable text leaf', state);

    await typeText(page, ' edited');
    await wait(300);
    const todo = (await blocks(page)).find(block => block.type === 'to_do');
    state = await page.evaluate(`(() => ({
      checked: document.querySelector(${JSON.stringify(checkboxSelector)})?.checked
    }))()`);
    assert(todo?.text.includes('edited'), 'typing after clicking to-do text should edit the to-do text', todo);
    assert(state.checked === false, 'typing in to-do text should not toggle the checkbox', state);

    await page.click(checkboxSelector);
    await wait(300);
    state = await page.evaluate(`(() => ({
      checked: document.querySelector(${JSON.stringify(checkboxSelector)})?.checked
    }))()`);
    assert(state.checked === true, 'clicking the checkbox control should still toggle the to-do', state);
    results.push('to-do text click/edit without checkbox toggle');
  } finally {
    await page.close();
  }
}

async function testTodoAndInsertionControls() {
  const page = await openPage('todo and insertion controls');
  try {
    await page.evaluate(`document.querySelector('.plim-example-block[data-plim-block-type="to_do"] input[type="checkbox"]').click()`);
    await wait(300);
    let checked = await page.evaluate(`document.querySelector('.plim-example-block[data-plim-block-type="to_do"] input[type="checkbox"]')?.checked`);
    assert(checked === true, 'to-do checkbox should toggle on', { checked });

    await page.evaluate(`document.querySelector('#insert-quote-inline').click()`);
    await wait(500);
    let snapshot = await blocks(page);
    assert(snapshot.at(-1)?.type === 'quote' && snapshot.at(-1)?.selected, 'quick insert quote should add and select quote', snapshot);

    await page.evaluate(`document.querySelector('[data-plim-editor]').click()`);
    await wait(500);
    snapshot = await blocks(page);
    assert(snapshot.at(-1)?.type === 'paragraph' && snapshot.at(-1)?.selected, 'clicking blank editor canvas should insert/select paragraph', snapshot);
    results.push('to-do toggle and insertion controls');
  } finally {
    await page.close();
  }
}

async function testReordering() {
  const page = await openPage('reordering');
  try {
    await page.evaluate(`document.querySelectorAll('.plim-example-block')[1].querySelector('[aria-label="Move block down"]').click()`);
    await wait(500);
    let snapshot = await blocks(page);
    assert(snapshot.map(block => block.type).slice(0, 3).join(',') === 'heading_1,to_do,paragraph', 'move down control should reorder blocks', snapshot);
    assert(snapshot[2].selected, 'moved block should remain selected after move down', snapshot);

    await page.evaluate(`document.querySelectorAll('.plim-example-block')[2].querySelector('[aria-label="Move block up"]').click()`);
    await wait(500);
    snapshot = await blocks(page);
    assert(snapshot.map(block => block.type).slice(0, 3).join(',') === 'heading_1,paragraph,to_do', 'move up control should reorder blocks', snapshot);
    assert(snapshot[1].selected, 'moved block should remain selected after move up', snapshot);

    const afterDrag = await page.evaluate(`new Promise(resolve => {
      const blocks = [...document.querySelectorAll('.plim-example-block')];
      const handle = blocks[1].querySelector('[aria-label="Drag block to reorder"]');
      const handleRect = handle.getBoundingClientRect();
      const targetRect = blocks[2].getBoundingClientRect();
      const startX = handleRect.left + handleRect.width / 2;
      const startY = handleRect.top + handleRect.height / 2;
      const endX = targetRect.left + targetRect.width / 2;
      const endY = targetRect.bottom - 2;
      handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: startX, clientY: startY }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, buttons: 1, clientX: endX, clientY: endY }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, clientX: endX, clientY: endY }));
      setTimeout(() => resolve(blockSnapshot()), 700);
    })`);
    assert(afterDrag.map(block => block.type).slice(0, 3).join(',') === 'heading_1,to_do,paragraph', 'drag handle should reorder blocks', afterDrag);
    assert(afterDrag[2].selected, 'dragged block should remain selected after drop', afterDrag);
    results.push('move controls and drag reorder');
  } finally {
    await page.close();
  }
}

function typeForSlashLabel(label) {
  const normalized = label.toLowerCase();
  if (normalized.includes('heading 1')) return 'heading_1';
  if (normalized.includes('heading 2')) return 'heading_2';
  if (normalized.includes('heading 3')) return 'heading_3';
  if (normalized.includes('to-do')) return 'to_do';
  if (normalized.includes('quote')) return 'quote';
  if (normalized.includes('divider')) return 'divider';
  return 'paragraph';
}

async function blocks(page) {
  return page.evaluate('blockSnapshot()');
}

async function slashMenuState(page) {
  return page.evaluate(`(() => {
    const menu = document.querySelector('#slash-menu');
    return {
      open: menu?.classList.contains('is-open') ?? false,
      role: menu?.getAttribute('role'),
      active: document.activeElement?.getAttribute('aria-activedescendant'),
      expanded: document.activeElement?.getAttribute('aria-expanded'),
      items: [...(menu?.querySelectorAll('button') ?? [])].map(button => ({
        text: button.textContent,
        selected: button.getAttribute('aria-selected'),
        active: button.classList.contains('is-active')
      }))
    };
  })()`);
}

async function activeInfo(page) {
  return page.evaluate(`(() => {
    const active = document.activeElement;
    const block = active?.closest?.('.plim-example-block');
    const range = getSelection()?.rangeCount ? getSelection().getRangeAt(0) : null;
    let offset = null;
    if (active && range && active.contains(range.commonAncestorContainer)) {
      const before = document.createRange();
      before.selectNodeContents(active);
      before.setEnd(range.startContainer, range.startOffset);
      offset = before.toString().length;
    }
    return {
      tag: active?.tagName,
      type: block?.dataset.plimBlockType,
      text: active?.textContent,
      offset,
      selected: block?.classList.contains('is-selected') ?? false
    };
  })()`);
}

async function createEmptyParagraphAfterSecondBlock(page) {
  await focusEditable(page, 1, 'end');
  await page.key('Enter', 'Enter', 13);
  await wait(350);
}

async function setEditableTextAndFocus(page, index, text, offset) {
  const safeOffset = typeof offset === 'number' ? offset : text.length;
  return page.evaluate(`(() => {
    const editable = document.querySelectorAll('[data-plim-editable="true"]')[${index}];
    editable.textContent = ${JSON.stringify(text)};
    editable.focus();
    const target = editable.firstChild ?? editable;
    const range = document.createRange();
    range.setStart(target, Math.min(${safeOffset}, editable.textContent.length));
    range.collapse(true);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  })()`);
}

async function focusEditable(page, index, boundary = 'end') {
  return page.evaluate(`(() => {
    const editable = document.querySelectorAll('[data-plim-editable="true"]')[${index}];
    if (!editable) return null;
    editable.focus();
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(${boundary === 'start'});
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  })()`);
}

async function typeText(page, text) {
  for (const char of text) {
    await page.character(char);
    await wait(40);
  }
  await wait(350);
}

function keyEventForCharacter(char) {
  if (/^[a-z]$/.test(char)) {
    return {
      key: char,
      code: `Key${char.toUpperCase()}`,
      windowsVirtualKeyCode: char.toUpperCase().charCodeAt(0),
      text: char
    };
  }
  if (/^[0-9]$/.test(char)) {
    return {
      key: char,
      code: `Digit${char}`,
      windowsVirtualKeyCode: char.charCodeAt(0),
      text: char
    };
  }
  switch (char) {
    case ' ':
      return { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' };
    case '/':
      return { key: '/', code: 'Slash', windowsVirtualKeyCode: 191, text: '/' };
    case '#':
      return { key: '#', code: 'Digit3', windowsVirtualKeyCode: 51, text: '#', unmodifiedText: '3', modifiers: { shiftKey: true } };
    case '[':
      return { key: '[', code: 'BracketLeft', windowsVirtualKeyCode: 219, text: '[' };
    case ']':
      return { key: ']', code: 'BracketRight', windowsVirtualKeyCode: 221, text: ']' };
    case '-':
      return { key: '-', code: 'Minus', windowsVirtualKeyCode: 189, text: '-' };
    case '.':
      return { key: '.', code: 'Period', windowsVirtualKeyCode: 190, text: '.' };
    case '"':
      return { key: '"', code: 'Quote', windowsVirtualKeyCode: 222, text: '"', unmodifiedText: "'", modifiers: { shiftKey: true } };
    default:
      return { key: char, code: '', windowsVirtualKeyCode: char.codePointAt(0) ?? 0, text: char };
  }
}

async function openPage(name) {
  const target = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(appUrl)}`, { method: 'PUT' }).then(response => response.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();

  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve: resolvePending, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${name}: ${JSON.stringify(message.error)}`));
    else resolvePending(message.result);
  };

  await new Promise((resolveOpen, rejectOpen) => {
    ws.onopen = resolveOpen;
    ws.onerror = rejectOpen;
  });

  const page = {
    async send(method, params = {}) {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolvePending, reject) => pending.set(id, { resolve: resolvePending, reject }));
    },
    async evaluate(expression) {
      const result = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`${name}: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}`);
      return result.result.value;
    },
    async key(key, code = key, windowsVirtualKeyCode = 0, modifiers = {}) {
      const modifierMask = modifierMaskFor(modifiers);
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers: modifierMask });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers: modifierMask });
    },
    async click(selector) {
      const point = await page.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      if (!point) throw new Error(`${name}: cannot click missing selector ${selector}`);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
    },
    async character(char) {
      const event = keyEventForCharacter(char);
      const modifierMask = modifierMaskFor(event.modifiers ?? {});
      const common = {
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: event.windowsVirtualKeyCode,
        nativeVirtualKeyCode: event.windowsVirtualKeyCode,
        modifiers: modifierMask
      };
      await page.send('Input.dispatchKeyEvent', {
        ...common,
        type: 'keyDown',
        text: event.text,
        unmodifiedText: event.unmodifiedText ?? event.text
      });
      await page.send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
    },
    async insert(text) {
      await page.send('Input.insertText', { text });
    },
    async reload() {
      await page.evaluate('location.reload(); true');
      await wait(800);
    },
    async waitForEditor() {
      await page.evaluate(`new Promise(resolve => {
        if (document.querySelectorAll('[data-plim-editable="true"]').length >= 3) resolve(true);
        const started = Date.now();
        const timer = setInterval(() => {
          if (document.querySelectorAll('[data-plim-editable="true"]').length >= 3 || Date.now() - started > 5000) {
            clearInterval(timer);
            resolve(true);
          }
        }, 50);
      })`);
      const count = await page.evaluate('document.querySelectorAll(\'[data-plim-editable="true"]\').length');
      if (count < 3) throw new Error(`Editor did not render enough editable blocks; found ${count}.`);
    },
    async close() {
      await fetch(`http://127.0.0.1:${cdpPort}/json/close/${target.id}`).catch(() => undefined);
      ws.close();
    }
  };

  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await wait(250);
  await page.evaluate(`(() => {
    window.blockSnapshot = () => [...document.querySelectorAll('.plim-example-block')].map(element => ({
      id: element.dataset.plimBlockId,
      type: element.dataset.plimBlockType,
      text: element.querySelector('[data-plim-editable="true"]')?.textContent ?? element.textContent,
      tag: element.querySelector('[data-plim-editable="true"]')?.tagName,
      selected: element.classList.contains('is-selected')
    }));
    localStorage.clear();
    location.reload();
    return true;
  })()`);
  await wait(700);
  await page.waitForEditor();
  await page.evaluate(`window.blockSnapshot = () => [...document.querySelectorAll('.plim-example-block')].map(element => ({
    id: element.dataset.plimBlockId,
    type: element.dataset.plimBlockType,
    text: element.querySelector('[data-plim-editable="true"]')?.textContent ?? element.textContent,
    tag: element.querySelector('[data-plim-editable="true"]')?.tagName,
    selected: element.classList.contains('is-selected')
  }))`);
  return page;
}

async function startVite() {
  vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: exampleRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = [];
  vite.stdout.on('data', chunk => output.push(String(chunk)));
  vite.stderr.on('data', chunk => output.push(String(chunk)));
  await waitFor(async () => {
    if (vite.exitCode !== null) throw new Error(`Vite exited before becoming ready:\n${output.join('')}`);
    try {
      const response = await fetch(appUrl);
      return response.ok;
    } catch {
      return false;
    }
  }, 15000, 'Vite dev server did not become ready');
}

async function startChrome() {
  chromeProfile = await mkdtemp(resolve(tmpdir(), 'plim-browser-regression-'));
  chrome = spawn(chromeBinary, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${chromeProfile}`,
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  chrome.stdout.on('data', chunk => output.push(String(chunk)));
  chrome.stderr.on('data', chunk => output.push(String(chunk)));
  await waitFor(async () => {
    if (chrome.exitCode !== null) throw new Error(`Chrome exited before CDP became ready:\n${output.join('')}`);
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      return response.ok;
    } catch {
      return false;
    }
  }, 15000, 'Chrome CDP did not become ready');
}

async function waitFor(check, timeoutMs, message) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await wait(100);
  }
  throw new Error(message);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    wait(3000).then(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    })
  ]);
}

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`}`);
  }
}

function modifierMaskFor(modifiers) {
  return (modifiers.altKey ? 1 : 0)
    | (modifiers.ctrlKey ? 2 : 0)
    | (modifiers.metaKey ? 4 : 0)
    | (modifiers.shiftKey ? 8 : 0);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function defaultChromeBinary() {
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') return 'chrome.exe';
  return 'google-chrome';
}
