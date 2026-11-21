import assert from 'node:assert/strict';
import { mkdir, mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { mapChange, ownDeath, status, verifiedItemReceipt } from './assistance-fixtures.mjs';
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

function wallet(amount) {
  const packet = status(20, amount);
  packet.writeUInt16LE(0x00b1);
  return packet;
}

function windowState() {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const windows = BrowserWindow.getAllWindows();
    const win = windows[0];
    const bounds = win.getBounds();
    return {
      count: windows.length, bounds, workArea: screen.getDisplayMatching(bounds).workArea,
      normal: win.getNormalBounds(), minimum: win.getMinimumSize(), maximized: win.isMaximized(),
      alwaysOnTop: win.isAlwaysOnTop(), resizable: win.isResizable(),
    };
  });
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
  const page = await app.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const launch = page.getByRole('button', { name: 'Görev çubuğu modu', exact: true });
  const strip = page.getByRole('main', { name: 'Görev çubuğu modu' });
  const exit = strip.getByRole('button', { name: 'Ana pencereye dön', exact: true });
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
  const compact = await windowState();
  assert.equal(compact.count, 1);
  assert.equal(compact.alwaysOnTop, true);
  assert.ok(compact.bounds.height < before.bounds.height);
  assert.ok(Math.abs(compact.bounds.y + compact.bounds.height - compact.workArea.y - compact.workArea.height) <= 1);
  const rows = adventureKeys.map(key => strip.locator(`article.taskbar-party-row[data-character-key="${key}"]`));
  assert.equal(await strip.locator('.taskbar-party-row').count(), 3);
  for (const [index,row] of rows.entries()) {
    await row.getByText(adventureNames[index], {exact:true}).waitFor();
    assert.equal(Number(await row.locator('.taskbar-strip-hp meter').getAttribute('value')), [98.7,96.8,88.1][index]);
    assert.ok((await row.locator('.taskbar-strip-zeny').innerText()).includes('—'));
  }
  await page.keyboard.press('/');
  assert.equal(await exit.evaluate(node => node === document.activeElement), true);
  const sound = strip.locator('.taskbar-strip-sound');
  assert.equal(await sound.getAttribute('aria-pressed'), 'false');
  await strip.getByRole('button', {name: 'Bildirim sesini %50 ile aç'}).click();
  await strip.getByRole('button', {name: 'Bildirim sesini kapat'}).waitFor();
  await sound.click();
  await strip.getByRole('button', {name: 'Bildirim sesini aç', exact: true}).waitFor();
  const soundPrefs = await page.evaluate(async () => (await window.midgard.getState()).assistance.preferences);
  assert.equal(soundPrefs.muted, true);
  assert.equal(soundPrefs.volume, 50);
  const exp = rows[0].locator('button.taskbar-exp');
  assert.match(await exp.locator('small').innerText(), /Kayıt başı/);
  assert.deepEqual(await exp.locator('span').allTextContents(), ['Base 10 12.450', 'Job 5 8.750']);
  await exp.click();
  assert.equal(await exp.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await exp.locator('span').allTextContents(), ['Base 10 7.550', 'Job 5 3.250']);
  await exp.click();
  assert.equal(await exp.getAttribute('aria-pressed'), 'false');

  const currentWeights = [12900,17400,63000];
  const maps = ['gef_fild10','gef_fild14','pay_fild03'];
  const opening = [30000, 10000, 25000];
  const budgets = [2050, 600, 350];
  for (let index=0; index<3; index++) await append(index, [mapChange(maps[index]), wallet(opening[index])], 701_000);
  const expectIncome = async (index, amount) => {
    await wait(page, async ({key, amount}) => {
      const state = await window.midgard.getState();
      return state.live.streams.find(s=>s.character?.key === key)?.summary?.liveTelemetry?.zenyReceived === amount;
    }, {key:adventureKeys[index], amount});
    const value = rows[index].locator('.taskbar-zeny-value');
    await value.filter({hasText:new Intl.NumberFormat('tr-TR').format(amount)}).waitFor();
    assert.equal((await value.innerText()).replace(/[^0-9]/g,''), String(amount));
  };
  async function receive(index, item, quantity, slot, at) {
    const after = currentWeights[index] + 10 * quantity;
    await append(index, verifiedItemReceipt(item,quantity,slot,currentWeights[index],after), at);
    await append(index, [status(5,[4935,4840,4405][index])], at+1000);
    currentWeights[index] = after;
  }
  // Earlier receipts count toward the day's totals even after their names leave the recent window.
  await receive(0,601,5,15,705000);
  await receive(0,603,9,11,710000);
  await receive(0,601,2,15,714000);
  await receive(0,909,4,16,718000);
  await receive(0,601,1,15,722000);
  await receive(1,603,1,11,710000);
  await receive(1,7054,5,15,714000);
  await receive(1,909,2,16,718000);
  await receive(2,909,2,15,710000);
  await receive(2,601,1,16,714000);
  await append(0,[wallet(31250),wallet(31050),wallet(31850)],730000);
  await append(1,[wallet(10600)],730000);
  await append(2,[wallet(25350),status(24,81450)],730000);
  for (const [index, amount] of budgets.entries()) await expectIncome(index,amount);
  const lootRows = rows.map(row=>row.locator('.taskbar-strip-loot'));
  const expectedLoot = [
    {total:21,items:['Fly Wing','Jellopy'],counts:[8,4]},
    {total:8,items:['Jellopy','Brigan','Old Blue Box'],counts:[2,5,1]},
    {total:3,items:['Fly Wing','Jellopy'],counts:[1,2]},
  ];
  for (const [index,expected] of expectedLoot.entries()) {
    const loot = lootRows[index];
    await loot.getByText(expected.items[0],{exact:true}).waitFor();
    assert.deepEqual(await loot.locator('.taskbar-loot-item strong').allTextContents(),expected.items);
    assert.deepEqual((await loot.locator('.taskbar-loot-item b').allTextContents()).map(t=>Number(t.replace(/[^0-9]/g,''))),expected.counts);
    assert.equal(await rows[index].locator('.taskbar-loot-total b').innerText(),String(expected.total));
    assert.ok(Math.abs(Number(await rows[index].locator('.taskbar-strip-weight meter').getAttribute('value')) - [13.11,17.48,81.45][index])<0.1);
    assert.equal(await rows[index].locator('.taskbar-weight-load').innerText(),['1.311 / 10.000','1.748 / 10.000','8.145 / 10.000'][index]);
    assert.ok((await rows[index].locator('.taskbar-zeny-balance').innerText()).includes(['31.850','10.600','25.350'][index]));
  }
  assert.ok((await strip.locator('.taskbar-party-wallet').innerText()).includes('3.000'));
  assert.equal(await rows[2].locator('.taskbar-strip-weight').getAttribute('data-warning'),'true');
  await append(1,[ownDeath(adventurePlayers[1])],740000);
  const deathScene = strip.locator('.taskbar-drop-scene[data-category="death"]');
  await deathScene.waitFor();
  assert.equal(await deathScene.locator('.drop-fighter-name strong').innerText(),adventureNames[1]);
  assert.match(await deathScene.locator('.drop-prize-name strong').innerText(),/öldü/i);
  await deathScene.waitFor({state:'hidden'});
  assert.equal(await lootRows[0].getByText('Fly Wing',{exact:true}).isVisible(), true);
  await page.evaluate(() => document.fonts.ready);
  await checkStripLayout(strip,true);
  const capture = process.argv.find(arg => arg.startsWith('--screenshot='))?.slice('--screenshot='.length);
  if (capture) {
    await exp.evaluate(node => node.blur());
    await mkdir(path.dirname(path.resolve(capture)), {recursive:true});
    await page.screenshot({path:capture, animations:'disabled'});
  }
  await app.evaluate(({BrowserWindow}) => {
    const win=BrowserWindow.getAllWindows()[0];
    win.setResizable(true); win.setMinimumSize(1,1);
    win.setContentSize(320,win.getContentSize()[1]);
  });
  await page.waitForFunction(() => innerWidth===320);
  for (const row of rows) {
    await row.scrollIntoViewIfNeeded();
    await checkStripLayout(strip,false);
  }
  await rows[0].scrollIntoViewIfNeeded();
  await exp.click();
  assert.equal(await rows[1].locator('.taskbar-exp').getAttribute('aria-pressed'),'false');
  await checkStripLayout(strip,false);

  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Escape');
  await strip.waitFor({ state: 'hidden' });
  assert.deepEqual(await windowState(), before);
  assert.equal(await launch.evaluate(node => node === document.activeElement), true);
  assert.equal((await page.evaluate(() => window.midgard.getLiveView())).characterKey, adventureKeys[0]);

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setAlwaysOnTop(true);
    win.maximize();
  });
  const maximized = await windowState();
  assert.equal(maximized.maximized, true);
  await launch.click();
  await exit.click();
  await strip.waitFor({ state: 'hidden' });
  assert.deepEqual(await windowState(), maximized);
  assert.deepEqual(errors, []);
  console.log('Üç karakterin aynı anda görünmesi, son üç ganimet, ağırlık, gelen Zeny, EXP ve ana pencereye dönüş doğrulandı.');
} finally {
  await app.close();
}
