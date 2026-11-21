import { _electron as electron } from 'playwright';
import path from 'node:path';
import { mkdir, writeFile, readFile, open } from 'node:fs/promises';
import { assistanceReplay, status, expReceived, syntheticWav } from './assistance-fixtures.mjs';
import { wait } from './qa-wait.mjs';

// Isolated, generated source-defined packets. This does not prove Skadi EXP availability.
const output = path.resolve('.qa', `auto-exp-ui-${Date.now()}`), sources = path.join(output, 'sources'), profile = path.join(output, 'profile');
await mkdir(sources, { recursive: true }); await mkdir(profile, { recursive: true });
const names = ['QA EXP Çağrı', 'QA EXP İpek', 'QA EXP Özgür', 'QA EXP Bilinmeyen'];
const classes = [0, 1, 8, 4008], levels = [53, 54, 55, 56], jobs = [5, 20, 51, 60];
const files = names.map((_, index) => path.join(sources, `SYNTHETIC-auto-exp-${index + 1}.rrf`));
const packets = names.map(() => [status(25, 100000), status(24, 60000), status(5, 10000)]);
const replay = index => assistanceReplay({ character: names[index], player: 42 + index, jobClassId: classes[index], baseLevel: levels[index], jobLevel: jobs[index], packets: packets[index] });
for (let index = 0; index < files.length; index++) await writeFile(files[index], replay(index));
const oldSound = path.join(sources, 'SYNTHETIC-preserved-card.wav'); await writeFile(oldSound, syntheticWav());
await writeFile(path.join(profile, 'live-preferences.json'), JSON.stringify({ version: 1, sources: [], manualBindings: [], alerts: { enabled: { death: true, weight: true, card: true, city: true, level: true, monster: true }, weightThreshold: 67, selectedCardIds: [4317], selectedMonsterIds: [1313], cityMaps: ['prontera'], volume: 43, muted: true }, soundPaths: { card: oldSound } }));
const env = { ...process.env, MIDGARD_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.MIDGARD_DEV_URL;
const checks = [], errors = []; let app;
const assert = (value, message) => { if (!value) throw Error(message); checks.push(message); };
const stateOf = page => page.evaluate(() => window.midgard.getState());
const openDetails = async card => { const details = card.locator('.character-exp-details'); if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click(); };
const settle = page => wait(page, async () => { const state = await window.midgard.getState(); return state.live.streams.length === 4 && !state.live.activeWorkers && !state.live.queuedCount && state.live.streams.every(stream => stream.summary && stream.status === 'settled'); }, {}, { timeout: 30000 });
async function launch() {
  const value = await electron.launch({ ...(process.argv[2] ? { executablePath: path.resolve(process.argv[2]), args: [] } : { args: ['.'] }), env, timeout: 30000 });
  const page = await value.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.midgard); await page.waitForSelector('h1');
  await page.evaluate(() => { window.__qaNotices = []; window.midgard.onNotification(value => window.__qaNotices.push(value)); });
  return { app: value, page };
}
async function grow(index, extra) {
  packets[index].push(...extra, status(5, 10000)); const bytes = replay(index), handle = await open(files[index], 'r+');
  try { await handle.write(bytes.subarray(352), 0, bytes.length - 352, 352); await handle.write(bytes.subarray(0, 352), 0, 352, 0); await handle.sync(); } finally { await handle.close(); }
}
try {
  let launched = await launch(); app = launched.app; let page = launched.page;
  await app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, files);
  await page.getByRole('button', { name: 'Dosya seç', exact: true }).first().click(); await settle(page);
  let state = await stateOf(page); const streams = names.map(name => state.live.streams.find(stream => stream.character.name === name));
  const view = index => state.expansion.experience[streams[index].id];
  assert(['novice', 'first', 'second'].every((track, index) => view(index).jobTrack === track && view(index).jobTrackSource === 'rrf-session-class'), 'Novice, First and Second Job tables load automatically from three distinct Session classes');
  assert(view(3).jobClassId === 4008 && view(3).jobTrack === null && view(3).job.required === null, 'An unsupported expanded class remains unknown rather than inferred from its level');
  assert(streams.every((stream, index) => view(index).base.level === levels[index] && view(index).job.level === jobs[index]), 'Base and Job levels load from recording metadata for every character');
  assert(streams.every((stream, index) => ['base', 'job'].every(kind => view(index)[kind].current === null && view(index)[kind].expPerHour === null && view(index)[kind].lastGainAmount === null)), 'Level-only recordings do not manufacture current EXP, hourly rates or latest gains');
  let card = page.locator(`[data-stream-id="${streams[2].id}"]`);
  assert((await card.locator('[aria-label="Base seviye"]').innerText()).includes('55') && (await card.locator('[aria-label="Job seviye"]').innerText()).includes('51') && await card.locator('[data-exp-hour]').count() === 2 && (await card.innerText()).includes('EXP verisi bekleniyor') && await card.locator('[aria-label="Base seviye"]').isVisible() && await card.locator('[aria-label="Job seviye"]').isVisible() && await card.locator('[data-exp-hour="base"]').isVisible() && await card.locator('[data-exp-hour="job"]').isVisible() && await card.locator('.character-exp').evaluate(element => element.getBoundingClientRect().height < 220 && !element.querySelector('.character-exp-details').open), 'Compact EXP panel shows both levels and hourly fields, stays under 220 pixels and keeps details closed by default');
  await openDetails(card);
  await card.locator('.expanded-exp-calibration summary').click();
  const selector = card.getByRole('combobox', { name: 'Meslek EXP tablosu', exact: true });
  assert(await selector.inputValue() === '', 'Automatic table mode is selected without asking the user to calibrate');
  await selector.selectOption('first'); await wait(page, async id => (await window.midgard.getState()).expansion.experience[id].jobTrackSource === 'manual', streams[2].id);
  assert((await stateOf(page)).expansion.experience[streams[2].id].jobTrack === 'first', 'A manual class selection overrides automatic metadata');
  await selector.selectOption(''); await wait(page, async id => { const value = (await window.midgard.getState()).expansion.experience[id]; return value.jobTrack === 'second' && value.jobTrackSource === 'rrf-session-class'; }, streams[2].id);
  assert(true, 'Choosing automatic again restores the source-proven Second Job table');
  await grow(2, [status(1, 1000), status(22, 5000), status(2, 200), status(23, 1000)]);
  await wait(page, async id => (await window.midgard.getState()).expansion.experience[id].base.current === 1000, streams[2].id); await settle(page);
  state = await stateOf(page); assert(view(2).base.expPerHour === null && view(2).job.expPerHour === null, 'A first absolute EXP observation supplies current values without inventing a gain rate');
  await page.waitForTimeout(1100);
  await grow(2, [expReceived(1200, 'base', 44), expReceived(300, 'job', 44), status(1, 2200), status(2, 500)]);
  await wait(page, async id => { const value = (await window.midgard.getState()).expansion.experience[id]; return value.base.lastGainAmount === 1200 && value.job.lastGainAmount === 300; }, streams[2].id); await settle(page);
  state = await stateOf(page);
  assert(view(2).base.current === 2200 && view(2).job.current === 500 && view(2).base.gains5m === 1200 && view(2).job.gains5m === 300, 'Fresh explicit gains and matching current packets are processed once for each EXP kind');
  assert(view(2).base.expPerHour > 0 && Math.abs(view(2).base.expPerHour / view(2).job.expPerHour - 4) < .001, 'Independent Base and Job hourly rates use the observed gain amounts');
  assert((await card.locator('[data-exp-last-gain="base"]').innerText()) === '+1.200' && (await card.locator('[data-exp-last-gain="job"]').innerText()) === '+300' && (await card.locator('[data-exp-hour="base"]').innerText()) !== '—', 'Opened EXP details retain latest Base and Job gains while hourly results stay in the compact summary');
  assert(view(0).base.expPerHour === null && view(1).base.current === null && view(3).job.current === null, 'One stream gaining EXP leaves the other three independent streams unchanged');
  await page.waitForTimeout(2100); state = await stateOf(page); assert(view(2).base.gains5m === 1200 && view(2).job.gains5m === 300, 'Repeated watcher snapshots do not count the same EXP twice');
  await grow(2, [expReceived(3000, 'base', 44), status(11, 56), status(1, 200), status(22, 6000), expReceived(600, 'job', 44), status(55, 52), status(2, 100), status(23, 1200)]);
  await wait(page, async id => { const value = (await window.midgard.getState()).expansion.experience[id]; return value.base.level === 56 && value.base.current === 200 && value.job.level === 52; }, streams[2].id); state = await stateOf(page);
  assert(view(2).base.gains5m === 4200 && view(2).job.gains5m === 900 && view(2).job.current === 100, 'Automatic level transitions retain the new absolute values without re-adding the same gains');
  await grow(2, [expReceived(-50, 'base', 44), status(1, 150)]); await wait(page, async id => (await window.midgard.getState()).expansion.experience[id].base.current === 150, streams[2].id);
  state = await stateOf(page); assert(view(2).base.gains5m === 4200 && view(2).base.losses5m === 50 && view(2).base.lastGainAmount === 3000, 'EXP loss stays separate from gained EXP and does not overwrite the latest positive gain');
  const otherCard = page.locator(`[data-stream-id="${streams[1].id}"]`); await openDetails(otherCard); await otherCard.locator('.expanded-exp-calibration summary').click(); await otherCard.getByRole('combobox', { name: 'Meslek EXP tablosu', exact: true }).selectOption('second');
  await wait(page, async id => (await window.midgard.getState()).expansion.experience[id].jobTrackSource === 'manual', streams[1].id);
  await card.getByRole('button', { name: 'Duraklat', exact: true }).click(); await wait(page, async id => (await window.midgard.getState()).live.streams.find(stream => stream.id === id).status === 'paused', streams[2].id);
  assert(await selector.isDisabled() && (await stateOf(page)).expansion.experience[streams[2].id].base.current === 150, 'Pausing retains the last EXP view and disables its manual controls');
  await card.getByRole('button', { name: 'Devam et', exact: true }).click(); await settle(page); state = await stateOf(page);
  assert(view(2).jobTrack === 'second' && view(2).jobTrackSource === 'rrf-session-class' && view(2).base.expPerHour === null, 'Resuming restores automatic class and silently baselines prior gains');
  await page.locator('.character-exp-details').evaluateAll(elements => elements.forEach(element => { element.open = false; }));
  while (await page.getByRole('button', { name: 'Uyarıyı kapat', exact: true }).count()) await page.getByRole('button', { name: 'Uyarıyı kapat', exact: true }).first().click();
  for (const width of [1480, 1280]) { await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 980), width); await page.waitForTimeout(120); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `EXP cards fit the ${width} pixel layout without horizontal overflow`); await page.screenshot({ path: path.join(output, `auto-exp-live-${width}.png`), fullPage: true }); }
  await app.close(); app = null; launched = await launch(); app = launched.app; page = launched.page; await settle(page); state = await stateOf(page);
  for (let index = 0; index < names.length; index++) streams[index] = state.live.streams.find(stream => stream.character.name === names[index]);
  assert(view(1).jobTrack === 'second' && view(1).jobTrackSource === 'manual' && view(2).jobTrack === 'second' && view(2).jobTrackSource === 'rrf-session-class', 'Restart preserves manual class preferences while other characters remain automatic');
  assert(view(2).base.expPerHour === null && view(2).base.lastGainAmount === null, 'Restart never presents historical file EXP as a newly earned hourly rate');
  const saved = JSON.parse(await readFile(path.join(profile, 'live-preferences.json'), 'utf8'));
  assert(saved.alerts.volume === 43 && saved.alerts.muted && saved.alerts.weightThreshold === 67 && saved.alerts.selectedCardIds.join() === '4317' && saved.soundPaths.card === oldSound, 'Existing card selection, sound path, mute, volume and weight preferences remain unchanged');
  assert(!errors.length, 'No renderer errors occur');
  const report = { passed: checks.length, checks, errors, fixture: 'Generated Session classes/levels and source-defined EXP packets only; no real gameplay copied.', limits: 'Actual inspected Skadi recordings expose levels/class but no supported current/gain EXP stream. Synthetic rate tests do not establish live Skadi EXP compatibility. No OCR or game intervention.' };
  await writeFile(path.join(output, 'auto-exp-ui-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, ...report }, null, 2));
} catch (error) { await writeFile(path.join(output, 'auto-exp-ui-failure.json'), JSON.stringify({ checks, errors, failure: String(error) }, null, 2)); try { await (await app?.firstWindow())?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); } catch {} throw error; }
finally { await app?.close(); }
