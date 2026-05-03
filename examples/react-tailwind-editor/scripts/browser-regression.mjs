import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5174'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'pipe'
});

let output = '';
server.stdout.on('data', (chunk) => {
  output += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  output += chunk.toString();
});

try {
  await waitForServer('http://127.0.0.1:5174');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto('http://127.0.0.1:5174');
  await page.getByText('React workspace').waitFor();
  const blocks = page.locator('[data-plim-block-content="true"]');

  await blocks.first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('React keyboard block');
  await setCaretOffset(page, 6);
  await page.keyboard.press('ArrowUp');
  const afterArrowUp = await activeTextAndOffset(page);
  if (!isMiddleCaret(afterArrowUp, 'Compose with the same PlimDriver API from React.')) {
    throw new Error(`Expected React ArrowUp to move directly to a middle caret in the previous block, got ${JSON.stringify(afterArrowUp)}`);
  }

  await page.keyboard.press('ArrowDown');
  const afterArrowDown = await activeTextAndOffset(page);
  if (!isMiddleCaret(afterArrowDown, 'React keyboard block')) {
    throw new Error(`Expected React ArrowDown to move directly to a middle caret in the next block, got ${JSON.stringify(afterArrowDown)}`);
  }

  await page.keyboard.press('End');
  await page.keyboard.press('/');
  await page.getByText('Basic blocks').waitFor();
  await page.getByRole('button', { name: '❝ Quote' }).click();
  await page.getByLabel('Add block').first().waitFor();

  const visual = await page.evaluate(() => {
    const card = document.querySelector('.editor-card');
    const cover = document.querySelector('.page-cover');
    if (!card || !cover) {
      throw new Error('Missing React page chrome for visual regression.');
    }
    const cardStyle = getComputedStyle(card);
    return {
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      cardRadius: cardStyle.borderRadius,
      cardShadow: cardStyle.boxShadow,
      cardWidth: card.getBoundingClientRect().width,
      coverDisplay: getComputedStyle(cover).display
    };
  });
  if (
    visual.bodyBackground !== 'rgb(255, 255, 255)' ||
    visual.cardRadius !== '0px' ||
    visual.cardShadow !== 'none' ||
    visual.coverDisplay !== 'none' ||
    visual.cardWidth > 720
  ) {
    throw new Error(`Expected React example to use a sparse Notion-like page canvas, got ${JSON.stringify(visual)}`);
  }

  await browser.close();
} finally {
  server.kill();
}

async function waitForServer(url) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until Vite is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`React Vite did not become ready.\n${output}`);
}

async function setCaretOffset(page, offset) {
  await page.evaluate((nextOffset) => {
    const active = document.activeElement;
    if (!active) {
      throw new Error('No active block to set caret.');
    }
    const textNode = active.firstChild ?? active.appendChild(document.createTextNode(''));
    const range = document.createRange();
    range.setStart(textNode, Math.min(nextOffset, textNode.textContent?.length ?? 0));
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, offset);
}

async function activeTextAndOffset(page) {
  return page.evaluate(() => {
    const selection = window.getSelection();
    return {
      text: document.activeElement?.textContent,
      offset: selection?.anchorOffset
    };
  });
}

function isMiddleCaret(result, expectedText) {
  return result.text === expectedText && result.offset > 0 && result.offset < expectedText.length;
}
