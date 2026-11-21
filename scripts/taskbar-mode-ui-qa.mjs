import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import { expReceived, mapChange, ownDeath, status, verifiedItemReceipt } from './assistance-fixtures.mjs';
import {mobDeath} from './kill-count-fixtures.mjs';
import { adventureKeys, adventureNames, adventurePlayers, seedLiveAdventure } from './live-adventure-fixtures.mjs';
import { wait } from './qa-wait.mjs';

// The app, its database and all appended packets use only this generated profile.
await using output = await mkdtempDisposable(path.join(tmpdir(), 'midgard-taskbar-'));
const startingExp = {base: 12450, requiredBase: 20000, job: 8750, requiredJob: 12000};
const extraItems = [{id: 601, name: 'Fly Wing'}, {id: 909, name: 'Jellopy'}, {id: 7054, name: 'Brigan'}];
const recordingDay = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Istanbul'}).format(new Date());
const fixture = await seedLiveAdventure(output.path, {openStream: true, experience: true, startingExp, extraItems, recordingDay});
const env = { ...process.env, MIDGARD_USER_DATA: fixture.profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MIDGARD_DEV_URL;
const app = await electron.launch({
  args: ['.', '--mute-audio', '--replace-live-sources', ...fixture.files.map(file => `--live-file=${file}`)],
  env, timeout: 30_000,
});
const capture = process.argv.find(arg => arg.startsWith('--screenshot='))?.slice('--screenshot='.length);

async function photograph(page, state) {
  if (!capture) return;
  const destination = path.resolve(capture);
  const file = state === 'compact' ? destination : path.join(path.dirname(destination), state + '.png');
  await mkdir(path.dirname(file), {recursive:true});
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({path:file, animations:'disabled'});
}

async function disclosedPanel(page, toggle) {
  const id = await toggle.getAttribute('aria-controls');
  assert.ok(id, 'Detay düğmesi açtığı bölümü tanımlamalı.');
  const panel = page.locator(`[id=${JSON.stringify(id)}]`);
  await panel.waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  return panel;
}

function wallet(amount) {
  const packet = status(20, amount);
  packet.writeUInt16LE(0x00b1);
  return packet;
}

async function checkHeader(strip, name, estimate, quantity, kills) {
  const title=strip.locator('.taskbar-party-title h1');
  await title.filter({hasText:name}).waitFor();
  assert.equal(await title.textContent(),name);
  const zeny=strip.locator('.taskbar-party-wallet strong');
  await zeny.filter({hasText:estimate}).waitFor();
  assert.equal(await zeny.textContent(),estimate);
  assert.equal(await strip.locator('.party-loot-metric strong').textContent(),String(quantity));
  assert.equal(await strip.locator('.party-hunt-metric strong').textContent(),String(kills));
}

function windowState() {
  return app.evaluate(({ BaseWindow, screen, webContents }) => {
    const visible = BaseWindow.getAllWindows().filter(win => win.isVisible());
    if (visible.length !== 1) throw new Error('Tek bir uygulama penceresi görünür olmalı.');
    const win = visible[0];
    const bounds = win.getBounds();
    return {
      visibleCount: visible.length, bounds, content: win.getContentBounds(), workArea: screen.getDisplayMatching(bounds).workArea,
      contents: webContents.getAllWebContents().filter(view => view.getURL().startsWith('file:')).map(view => view.id),
      normal: win.getNormalBounds(), minimum: win.getMinimumSize(), maximized: win.isMaximized(),
      alwaysOnTop: win.isAlwaysOnTop(), resizable: win.isResizable(),
    };
  });
}

async function checkDockBounds(page) {
  // Changing direction can resize the window twice: first the host, then the reflowed detail.
  const deadline = Date.now() + 3000;
  let state, viewport;
  do {
    state = await windowState();
    viewport = await page.evaluate(() => [innerWidth, innerHeight]);
    if (viewport[0] === state.bounds.width && viewport[1] === state.bounds.height) break;
    await delay(25);
  } while (Date.now() < deadline);
  const {bounds, content, workArea} = state;
  assert.deepEqual(content, bounds, 'Av Ekibi penceresinde Windows başlık çubuğu veya dış çerçeve olmamalı.');
  assert.deepEqual(viewport, [bounds.width, bounds.height]);
  assert.ok(bounds.x >= workArea.x - 1 && bounds.y >= workArea.y - 1);
  assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width + 1);
  assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height + 1);
  return state;
}

// Only this temporary Electron instance sees a narrow monitor. Native resizing,
// content measurement and bottom docking still run through the production path.
async function simulateNarrowMonitor(width) {
  await app.evaluate(({screen}, width) => {
    if (width) {
      if (!globalThis.originalQADisplay) globalThis.originalQADisplay = screen.getDisplayMatching;
      const original = globalThis.originalQADisplay;
      screen.getDisplayMatching = (bounds) => {
        const display = original.call(screen, bounds);
        return {...display, workArea:{...display.workArea, width}};
      };
    } else {
      screen.getDisplayMatching = globalThis.originalQADisplay;
      delete globalThis.originalQADisplay;
    }
    screen.emit('display-metrics-changed');
  }, width);
}

async function checkStripLayout(strip, allVisible) {
  const issues = await strip.evaluate((root, allVisible) => {
    const problems = [];
    const rows = [...root.querySelectorAll('.taskbar-party-row')];
    for (const row of rows) {
      const box = row.getBoundingClientRect();
      if (allVisible && (box.top < 0 || box.bottom > innerHeight + 1)) problems.push('Karakter satırı pencere dışında');
      if (row.scrollWidth > row.clientWidth + 1) problems.push('Satır içinde yatay taşma');
    }
    for (const group of root.querySelectorAll('.taskbar-party-bar, .taskbar-party-summary, .party-actions, .party-metrics')) {
      const cells = [...group.children].map(node => node.getBoundingClientRect()).filter(rect => rect.width && rect.height);
      for (const [index, cell] of cells.entries()) for (const other of cells.slice(index + 1)) {
        const width = Math.min(cell.right, other.right) - Math.max(cell.left, other.left);
        const height = Math.min(cell.bottom, other.bottom) - Math.max(cell.top, other.top);
        if (width > 1 && height > 1) problems.push('Komşu hücreler çakışıyor: ' + group.className);
      }
    }
    for (const node of root.querySelectorAll('.taskbar-exp, .taskbar-strip-weight, .taskbar-strip-identity, .taskbar-strip-loot, .taskbar-strip-zeny, .taskbar-strip-exit')) {
      const box = node.getBoundingClientRect();
      if (box.width && (box.left < -1 || box.right > innerWidth + 1)) problems.push(node.textContent + ' pencere dışında');
    }
    if (root.scrollWidth > root.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1) problems.push('yatay taşma');
    return problems;
  }, allVisible);
  assert.deepEqual(issues, []);
}

try {
  // Playwright's firstWindow() enumerates BrowserWindow. The renderer is hosted by a WebContentsView.
  const context = app.context();
  const page = context.pages()[0] ?? await context.waitForEvent('page', {timeout:30_000});
  await page.waitForURL(url => url.protocol === 'file:');
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const launch = page.getByRole('button', { name: 'Görev çubuğu modu', exact: true });
  const strip = page.getByRole('main', { name: 'Görev çubuğu modu' });
  const exit = strip.getByRole('button', { name: 'Ana pencereye dön', exact: true });
  const pin = strip.getByRole('button', { name: 'Her zaman üstte', exact: true });
  const orient = async (orientation, width) => {
    const name = orientation === 'vertical' ? 'Dikey görünüme geç' : 'Yatay görünüme geç';
    await strip.getByRole('button', {name, exact:true}).click();
    await page.waitForFunction(({orientation,width}) =>
      document.querySelector('.taskbar-strip')?.dataset.layout === orientation && innerWidth === width, {orientation,width});
    return checkDockBounds(page);
  };
  async function append(index, packets, time) {
    await fixture.append(index, packets, time);
    await wait(page, async ({key, count}) => {
      const {live} = await window.midgard.getState();
      return live.streams.find(stream => stream.character?.key === key)?.packetCount === count;
    }, {key: adventureKeys[index], count: fixture.entries[index].length});
  }
  await launch.waitFor();
  await wait(page, async () => {
    const { live } = await window.midgard.getState();
    return live.streams.length === 3 && live.streams.every(s => s.summary && ['settled', 'following'].includes(s.status))
      && !live.activeWorkers && !live.queuedCount;
  }, null, { timeout: 30_000 });

  await page.getByRole('button', { name: `${adventureNames[0]} ayrıntılarını aç`, exact: true }).click();
  await page.evaluate(async keys => {
    const view = await window.midgard.getLiveView();
    await window.midgard.setLiveView({...view, appearanceByCharacter: {
      [keys[0]]: 'masculine-1', [keys[1]]: 'feminine-2', [keys[2]]: 'masculine-3',
    }});
    await window.midgard.setAlertPreferences({enabled: {'old-blue-box': false}});
  }, adventureKeys);
  const before = await windowState();
  await launch.click();
  await strip.waitFor();
  const compact = await checkDockBounds(page);
  assert.equal(compact.visibleCount, 1);
  assert.equal(compact.contents.length, 1);
  assert.deepEqual(compact.contents, before.contents);
  assert.equal(await strip.getAttribute('data-layout'), 'horizontal');
  assert.equal(compact.alwaysOnTop, true);
  assert.equal(compact.bounds.width, Math.min(1000, compact.workArea.width));
  assert.ok(compact.bounds.height < before.bounds.height);
  assert.ok(Math.abs(compact.bounds.y + compact.bounds.height - compact.workArea.y - compact.workArea.height) <= 1);
  const rows = adventureKeys.map(key => strip.locator(`article.taskbar-party-row[data-character-key="${key}"]`));
  assert.equal(await strip.locator('.taskbar-party-row').count(), 3);
  for (const [index,row] of rows.entries()) {
    await row.getByText(adventureNames[index], {exact:true}).waitFor();
    assert.equal(Number(await row.locator('.taskbar-strip-hp meter').getAttribute('value')), [98.7,96.8,88.1][index]);
    assert.ok((await row.locator('.taskbar-strip-zeny').innerText()).includes('—'));
    assert.equal(await row.locator('.taskbar-loot-item').count(), 0, 'Replay başındaki çanta içeriği yeni ganimet sayılamaz.');
  }
  await page.keyboard.press('/');
  assert.equal(await exit.evaluate(node => node === document.activeElement), true);
  assert.equal(await pin.getAttribute('aria-pressed'), 'true');
  for (const expected of [false, true]) {
    await pin.click();
    await page.waitForFunction(expected => document.querySelector('.taskbar-pin')?.getAttribute('aria-pressed') === String(expected), expected);
    assert.equal((await windowState()).alwaysOnTop, expected);
  }
  const sound = strip.locator('.taskbar-strip-sound');
  assert.equal(await sound.getAttribute('aria-pressed'), 'false');
  await strip.getByRole('button', {name: 'Bildirim sesini %50 ile aç'}).click();
  await strip.getByRole('button', {name: 'Bildirim sesini kapat'}).waitFor();
  await sound.click();
  await strip.getByRole('button', {name: 'Bildirim sesini aç', exact: true}).waitFor();
  const soundPrefs = await page.evaluate(async () => (await window.midgard.getState()).assistance.preferences);
  assert.equal(soundPrefs.muted, true);
  assert.equal(soundPrefs.volume, 50);
  const toggles = rows.map(row => row.locator('button[aria-expanded][aria-controls]'));
  for (const [index, row] of rows.entries()) {
    assert.equal(await toggles[index].getAttribute('aria-expanded'), 'false');
    const portrait = row.locator('.taskbar-strip-scene img');
    assert.ok(await portrait.evaluate(img => img.complete && img.naturalWidth > 0));
    assert.equal(await row.locator('.taskbar-recording').innerText(), path.basename(fixture.files[index]));
    assert.deepEqual(await row.locator('.taskbar-exp > div > span').allTextContents(), ['Base 10', 'Job 5']);
    assert.deepEqual(await row.locator('.taskbar-exp > div > strong').allTextContents(), ['—', '—']);
  }

  const currentWeights = [12900,17400,63000];
  const maps = ['gef_fild10','gef_fild14','pay_fild03'];
  const opening = [30000, 10000, 25000];
  const budgets = [2050, 600, 350];
  await append(0, [mapChange(maps[0]), wallet(opening[0]), wallet(31250)], 701_000);
  await rows[0].locator('.taskbar-zeny-value strong').filter({hasText:'≈0 Z'}).waitFor();
  assert.equal(await rows[0].locator('.taskbar-zeny-balance b').textContent(),'31.250');
  await rows[0].locator('.taskbar-strip-source').filter({hasText:'Canlı'}).waitFor();
  assert.equal(await strip.locator('.party-connection').getAttribute('data-live'), 'true');
  for (const index of [1,2]) await append(index, [mapChange(maps[index]), wallet(opening[index])], 701_000);
  const expectIncome = async (index, amount) => {
    await wait(page, async ({key, amount}) => {
      const state = await window.midgard.getState();
      return state.live.streams.find(s=>s.character?.key === key)?.summary?.liveTelemetry?.zenyReceived === amount;
    }, {key:adventureKeys[index], amount});
  };
  async function receive(index, item, quantity, slot, at) {
    const after = currentWeights[index] + 10 * quantity;
    await append(index, verifiedItemReceipt(item,quantity,slot,currentWeights[index],after), at);
    await append(index, [status(5,[4935,4840,4405][index])], at+1000);
    currentWeights[index] = after;
  }
  // Earlier receipts count toward the day's totals even after their names leave the recent window.
  await receive(0,7054,2,17,703000);
  await receive(0,601,5,15,705000);
  await receive(0,603,7,11,710000);
  await receive(0,601,2,15,714000);
  await receive(0,909,4,16,718000);
  await receive(0,601,1,15,722000);
  await receive(1,603,1,11,710000);
  await receive(1,7054,5,15,714000);
  await receive(1,909,2,16,718000);
  await receive(2,909,2,15,710000);
  await receive(2,601,1,16,714000);
  await append(0,[wallet(31050),wallet(31850),expReceived(403,'base',adventurePlayers[0]),expReceived(76,'job',adventurePlayers[0])],730000);
  await append(1,[wallet(10600)],730000);
  await append(2,[wallet(25350),status(24,81450)],730000);
  const firstKill=mobDeath(94001,1002,'Poring',adventurePlayers[0]);
  await append(0,[...firstKill,...mobDeath(94002,1002,'Poring',adventurePlayers[0])],733000);
  await append(1,mobDeath(94003,1002,'Poring',adventurePlayers[1]),733000);
  // The third recording saw the first character's target die but did not damage it.
  await append(2,firstKill,733000);
  for (const [index, amount] of budgets.entries()) await expectIncome(index,amount);
  const lootRows = rows.map(row=>row.locator('.taskbar-strip-loot'));
  const expectedLoot = [
    {total:21,items:['Fly Wing','Jellopy','Old Blue Box'],counts:[8,4,7]},
    {total:8,items:['Jellopy','Brigan','Old Blue Box'],counts:[2,5,1]},
    {total:3,items:['Fly Wing','Jellopy'],counts:[1,2]},
  ];
  const daily = await page.evaluate(async keys => {
    const {live} = await window.midgard.getState();
    return keys.map(key => live.streams.find(stream => stream.character?.key === key)?.taskbarDay);
  }, adventureKeys);
  for (const [index, expected] of expectedLoot.entries()) {
    assert.equal(daily[index]?.date, recordingDay);
    assert.equal(daily[index]?.zenyReceived, budgets[index]);
    assert.equal(daily[index]?.items.reduce((sum, item) => sum + item.quantity, 0), expected.total);
    assert.deepEqual(daily[index]?.recentItemIds, [[601,909,603], [909,7054,603], [601,909]][index]);
  }
  for (const [index,expected] of expectedLoot.entries()) {
    const loot = lootRows[index];
    await loot.getByText(expected.items[0],{exact:true}).waitFor();
    assert.deepEqual(await loot.locator('.taskbar-loot-item strong').allTextContents(),expected.items);
    assert.deepEqual((await loot.locator('.taskbar-loot-item b').allTextContents()).map(t=>Number(t.replace(/[^0-9]/g,''))),expected.counts);
    assert.ok(Math.abs(Number(await rows[index].locator('.taskbar-strip-weight meter').getAttribute('value')) - [13.11,17.48,81.45][index])<0.1);
    assert.equal(await rows[index].locator('.taskbar-weight-load').innerText(),['1.311 / 10.000','1.748 / 10.000','8.145 / 10.000'][index]);
    assert.ok((await rows[index].locator('.taskbar-zeny-balance').innerText()).includes(['31.850','10.600','25.350'][index]));
  }
  await checkHeader(strip,'Av Ekibi','≈280.000 Z*',32,3);
  assert.equal(await strip.locator('.taskbar-party-wallet').getAttribute('data-partial'),'true');
  const perRowEstimate=() => Promise.all(rows.map(row=>row.locator('.taskbar-zeny-value strong').textContent()));
  assert.deepEqual(await perRowEstimate(),['≈245.000 Z*','≈35.000 Z*','Fiyat bekleniyor']);
  // Revalue the same receipts through Finance without adding loot or moving any wallet.
  await page.evaluate(async () => {
    for (const [itemId,unitPrice] of [[601,100],[909,3],[7054,50]]) await window.midgard.setFarmPrice({itemId,unitPrice});
  });
  const teamEstimate='≈281.274 Z', estimates=['≈245.912 Z','≈35.256 Z','≈106 Z'];
  await checkHeader(strip,'Av Ekibi',teamEstimate,32,3);
  assert.equal(await strip.locator('.taskbar-party-wallet').getAttribute('data-partial'),'false');
  assert.deepEqual(await perRowEstimate(),estimates);
  assert.equal(await strip.locator('.party-duration').count(), 0, 'Üç paralel Replay süresi bir ekip av süresi değildir.');
  assert.deepEqual(await rows[0].locator('.taskbar-exp > div > strong').allTextContents(), ['+403', '+76']);
  assert.deepEqual(await rows[1].locator('.taskbar-exp > div > strong').allTextContents(), ['—', '—']);
  assert.equal(await rows[2].locator('.taskbar-strip-weight').getAttribute('data-warning'),'true');
  await append(1,[ownDeath(adventurePlayers[1])],740000);
  const deathScene = strip.locator('.taskbar-drop-scene[data-category="death"]');
  await deathScene.waitFor();
  assert.equal(await deathScene.locator('.drop-fighter-name strong').innerText(),adventureNames[1]);
  assert.match(await deathScene.locator('.drop-prize-name strong').innerText(),/öldü/i);
  assert.ok(await deathScene.evaluate(node => {
    const {width,height} = node.getBoundingClientRect();
    return width >= innerWidth - 4 && height >= innerHeight - 4;
  }));
  await deathScene.waitFor({state:'hidden'});
  await strip.locator('.taskbar-strip-notice span').waitFor({state:'hidden'});
  for (const [index,hp] of [4934,4839,4404].entries()) await append(index, [status(5,hp)], 750000);
  await strip.locator('.party-connection').filter({hasText:'3 canlı'}).waitFor();
  assert.equal(await lootRows[0].getByText('Fly Wing',{exact:true}).isVisible(), true);
  await page.evaluate(() => document.fonts.ready);
  await checkStripLayout(strip,true);
  const collapsedViewport = await page.evaluate(() => ({width:innerWidth,height:innerHeight}));
  await photograph(page, 'compact');
  await rows[0].locator('.taskbar-strip-identity').click();
  const details = await disclosedPanel(page, toggles[0]);
  await checkHeader(strip,adventureNames[0],estimates[0],21,2);
  await page.waitForFunction(height => innerHeight > height, collapsedViewport.height);
  const expanded = await windowState();
  assert.ok(expanded.bounds.height > compact.bounds.height);
  assert.equal(expanded.bounds.y + expanded.bounds.height, compact.bounds.y + compact.bounds.height);
  assert.equal(expanded.bounds.width, compact.bounds.width);
  assert.equal(await details.locator('.taskbar-loot-total b').innerText(), '21');
  assert.deepEqual((await details.getByRole('list', {name:'Günlük ganimet listesi'}).getByRole('listitem').allTextContents()).sort(),
    ['Fly Wing×8','Old Blue Box×7','Jellopy×4','Brigan×2'].sort());
  assert.deepEqual(await details.locator('.party-detail-wallet dd').allTextContents(), [estimates[0],'+2.050','+2.050','31.850']);
  assert.deepEqual(await details.getByRole('row').filter({hasText:'Kaydedilen kazanç'}).getByRole('cell').allTextContents(), ['403','76']);
  assert.deepEqual(await details.getByRole('row').filter({hasText:'Kayıt başı'}).getByRole('cell').allTextContents(), ['12.450','8.750']);
  assert.ok(Number.isFinite(Date.parse(await details.locator('time').getAttribute('datetime'))));
  assert.equal(await details.locator('time').innerText() === '—', false);
  const hourly = details.getByText(/Ganimet \/ izleme saati/);
  const observedMs = await page.evaluate(async key => (await window.midgard.getState()).live.streams.find(s => s.character?.key === key).taskbarDay.observedMs, adventureKeys[0]);
  if (observedMs) {
    const rounded = new Intl.NumberFormat('tr-TR', {maximumFractionDigits:1}).format(21 * 3_600_000 / observedMs);
    assert.equal(await hourly.locator('b').innerText(), rounded);
  } else {
    assert.equal(await hourly.count(), 0);
  }
  await checkStripLayout(strip, true);
  await photograph(page, 'expanded');
  const verticalWidth = Math.min(392, compact.workArea.width);
  const verticalExpanded = await orient('vertical', verticalWidth);
  assert.deepEqual(verticalExpanded.contents, before.contents);
  assert.equal(await toggles[0].getAttribute('aria-expanded'), 'true');
  await disclosedPanel(page, toggles[0]);
  await checkHeader(strip,adventureNames[0],estimates[0],21,2);
  await checkStripLayout(strip, true);
  await toggles[0].click();
  await page.waitForFunction(height => innerHeight < height, verticalExpanded.bounds.height);
  await checkHeader(strip,'Av Ekibi',teamEstimate,32,3);
  await checkDockBounds(page);
  await photograph(page, 'vertical');
  await toggles[0].click();
  await disclosedPanel(page, toggles[0]);
  await orient('horizontal',compact.bounds.width);
  await checkHeader(strip,adventureNames[0],estimates[0],21,2);
  assert.equal(await toggles[0].getAttribute('aria-expanded'), 'true');
  await toggles[1].click();
  const secondDetails = await disclosedPanel(page, toggles[1]);
  await checkHeader(strip,adventureNames[1],estimates[1],8,1);
  assert.equal(await secondDetails.locator('.taskbar-loot-total b').innerText(), '8');
  assert.equal(await rows[1].getAttribute('data-selected'), 'true');
  assert.equal(await rows[0].getAttribute('data-selected'), 'false');
  assert.equal(await rows[2].getAttribute('data-selected'), 'false');
  assert.notEqual(await rows[1].evaluate(row => getComputedStyle(row).borderTopColor), await rows[0].evaluate(row => getComputedStyle(row).borderTopColor));
  await toggles[0].click();
  await toggles[0].press('Enter');
  await details.waitFor({state:'hidden'});
  await checkHeader(strip,'Av Ekibi',teamEstimate,32,3);
  await page.waitForFunction(height => innerHeight === height, collapsedViewport.height);
  await simulateNarrowMonitor(320);
  await page.waitForFunction(() => innerWidth <= 320);
  assert.equal((await windowState()).bounds.width, 320);
  for (const row of rows) {
    await row.scrollIntoViewIfNeeded();
    await checkStripLayout(strip,false);
    assert.ok(await row.locator('.taskbar-hp-load,.taskbar-weight-load').evaluateAll(labels =>
      labels.every(label => label.scrollWidth <= label.clientWidth + 1)), 'Dar ekranda kapasite ve mevcut değer kesilmemeli.');
  }
  await rows[0].scrollIntoViewIfNeeded();
  await photograph(page, 'narrow');
  await toggles[0].click();
  await disclosedPanel(page, toggles[0]);
  await checkHeader(strip,adventureNames[0],estimates[0],21,2);
  assert.equal(await toggles[1].getAttribute('aria-expanded'),'false');
  await checkStripLayout(strip,false);
  await orient('vertical',320);
  assert.equal(await toggles[0].getAttribute('aria-expanded'),'true');
  await checkHeader(strip,adventureNames[0],estimates[0],21,2);
  await checkStripLayout(strip,false);
  await orient('horizontal',320);
  assert.equal(await toggles[0].getAttribute('aria-expanded'),'true');
  await toggles[0].click();
  await checkHeader(strip,'Av Ekibi',teamEstimate,32,3);
  await checkStripLayout(strip,false);

  for (const width of [392,600,780]) {
    await simulateNarrowMonitor(width);
    await page.waitForFunction(width => innerWidth <= width && innerWidth >= width - 24, width);
    const readyHeight = await page.evaluate(() => innerHeight);
    await checkStripLayout(strip,true);
    await toggles[1].click();
    await disclosedPanel(page,toggles[1]);
    await page.waitForFunction(height => innerHeight > height, readyHeight);
    await checkStripLayout(strip,true);
    await checkDockBounds(page);
    await toggles[1].click();
    await page.waitForFunction(height => innerHeight === height, readyHeight);
  }
  await simulateNarrowMonitor(null);
  await page.waitForFunction(width => innerWidth === width, collapsedViewport.width);
  const thirdStream = await rows[2].getAttribute('data-stream-id');
  await page.evaluate(id => window.midgard.controlLive(id, 'pause'), thirdStream);
  await rows[2].locator('.taskbar-strip-source').filter({hasText:'Duraklatıldı'}).waitFor();
  assert.match(await rows[2].locator('.taskbar-zeny-balance').innerText(), /25\.350/);
  assert.equal(await rows[2].locator('.taskbar-weight-load').innerText(), '8.145 / 10.000');
  await page.evaluate(id => window.midgard.controlLive(id, 'resume'), thirdStream);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Escape');
  await strip.waitFor({ state: 'hidden' });
  assert.deepEqual(await windowState(), before);
  assert.equal(await launch.evaluate(node => node === document.activeElement), true);
  assert.equal((await page.evaluate(() => window.midgard.getLiveView())).characterKey, adventureKeys[0]);

  await launch.click();
  const settings = strip.getByRole('button', {name:/ayar/i});
  await settings.click();
  await page.getByRole('heading', {name:'Bildirim merkezi'}).waitFor();
  const guide = page.getByRole('region', {name:'Kullanım rehberi'});
  await guide.waitFor();
  const instructions = guide.locator('summary').filter({hasText:'Küçük Av Ekibi panelini'});
  await instructions.focus();
  await instructions.press('Enter');
  await guide.getByText('Her zaman üstte',{exact:true}).waitFor();
  await guide.getByText('Dikey görünüme geç',{exact:true}).waitFor();
  await instructions.press('Space');
  assert.equal(await instructions.evaluate(el => el.parentElement.open),false);
  assert.deepEqual(await windowState(), before);
  await page.getByRole('navigation', {name:'Ana gezinme'}).getByRole('button', {name:/^Canlı takip/}).click();
  await app.evaluate(({ BaseWindow }) => {
    const win = BaseWindow.getAllWindows().find(win => win.isVisible());
    win.setAlwaysOnTop(true);
    win.maximize();
  });
  const maximized = await windowState();
  assert.equal(maximized.maximized, true);
  await launch.click();
  assert.equal(await strip.locator('.taskbar-party-row').count(), 3);
  await checkHeader(strip,'Av Ekibi',teamEstimate,32,3);
  await orient('vertical',verticalWidth);
  await pin.click();
  await page.waitForFunction(() => document.querySelector('.taskbar-pin')?.getAttribute('aria-pressed') === 'false');
  await exit.click();
  await strip.waitFor({ state: 'hidden' });
  assert.deepEqual(await windowState(), maximized);
  await launch.click();
  await page.waitForFunction(w => document.querySelector('.taskbar-strip')?.dataset.layout === 'vertical' && innerWidth === w,verticalWidth);
  assert.equal((await checkDockBounds(page)).alwaysOnTop,false);
  assert.equal(await pin.getAttribute('aria-pressed'),'false');
  const exited = once(app.process(), 'exit', {signal: AbortSignal.timeout(30_000)});
  await strip.getByRole('button',{name:'Uygulamayı kapat',exact:true}).click();
  const [code, signal] = await exited;
  assert.equal(code, 0); assert.equal(signal, null);
  const db = new DatabaseSync(fixture.database,{readOnly:true});
  try {
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    const record = db.prepare('SELECT value_json FROM expansion_settings WHERE key=?').get('taskbar-options');
    assert.deepEqual(JSON.parse(record.value_json),{pinned:false,orientation:'vertical'});
  } finally { db.close(); }
  assert.deepEqual(errors, []);
  console.log('Üç Replay kaydında cüzdan, ganimet, EXP, Av Ekibi başlıkları ve bildirimler doğrulandı. Windows çerçevesiz panel, üste tutma, yatay/dikey görünüm, 320/392/600/780 piksel, açık detay, rehber, ana pencereye dönüş, kayıtlı tercihler ve temiz kapatma kontrolleri geçti.');
} finally {
  if (app.process().exitCode === null && app.process().signalCode === null) await app.close();
}
