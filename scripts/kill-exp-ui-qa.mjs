import { _electron as electron } from 'playwright';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, open, rename } from 'node:fs/promises';
import { assistanceReplay, baselinePackets, status, mobDeath, vanish } from './kill-count-fixtures.mjs';
import { syntheticWav } from './assistance-fixtures.mjs';
import { wait } from './qa-wait.mjs';

// Generated observations test a manual estimate. They never prove actual Skadi EXP.
const output = path.resolve('.qa', `kill-exp-ui-${Date.now()}`);
const sources = path.join(output, 'sources'), profile = path.join(output, 'profile');
await mkdir(sources, { recursive: true }); await mkdir(profile, { recursive: true });
const names = ['QA Tahmini Çağrı', 'QA Tahmini Çağrı', 'QA Tahmini Çağrı', 'QA Tahmini İpek', 'QA Cezasız Özgür'];
const players = [42, 42, 42, 43, 44];
const files = names.map((_, index) => path.join(sources, `SYNTHETIC-kill-exp-${index + 1}.rrf`));
const noExpBaseline = () => baselinePackets().filter(packet => packet.readUInt16LE(0) !== 0x00b0 || ![1, 2, 22, 23].includes(packet.readUInt16LE(2)));
const packets = names.map((_, index) => [...noExpBaseline(), ...Array.from({ length: 65 }, () => status(5, 10000)), ...mobDeath(1000, 1002, 'QA Monster A', players[index]), ...mobDeath(1001, 1003, 'QA Monster B', players[index])]);
const replay = index => assistanceReplay({ character: names[index], player: players[index], jobClassId: 8, baseLevel: 30, jobLevel: 10, packets: packets[index] });
const resurrect = player => { const packet = Buffer.alloc(8); packet.writeUInt16LE(0x0148); packet.writeUInt32LE(player, 2); return packet; };
const penaltyAmount = (required, percent) => Number(BigInt(required) * BigInt(percent) / 100n);
for (let index = 0; index < files.length; index++) await writeFile(files[index], replay(index));
const sound = path.join(sources, 'SYNTHETIC-preserved-card.wav'); await writeFile(sound, syntheticWav());
await writeFile(path.join(profile, 'live-preferences.json'), JSON.stringify({ version: 1, sources: [], manualBindings: [], soundPaths: { card: sound }, alerts: { enabled: { death: true, weight: true, card: true, city: true, level: true, monster: true }, weightThreshold: 67, selectedCardIds: [4317], selectedMonsterIds: [1313], cityMaps: ['prontera'], volume: 43, muted: true } }));
const env = { ...process.env, MIDGARD_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.MIDGARD_DEV_URL;
const checks = [], errors = [], screenshots = []; let app, page;
const assert = (value, message) => { if (!value) throw Error(message); checks.push(message); };
const stateOf = () => page.evaluate(() => window.midgard.getState());
const estimateOf = (state, key) => state.expansion.killExperience.characters.find(character => character.characterKey === key);
const sourceOf = (state, index) => state.live.streams.find(stream => path.resolve(stream.sourcePath).toLowerCase() === files[index].toLowerCase());
const panel = () => page.locator('.kill-count-panel');
const controlInput = (state, index, action) => { const stream = sourceOf(state, index); return { characterKey: stream.character.key, streamId: stream.id, recordingId: state.expansion.experience[stream.id].recordingId, action }; };
async function launch() {
  app = await electron.launch({ ...(process.argv[2] ? { executablePath: path.resolve(process.argv[2]), args: [] } : { args: ['.'] }), env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.midgard); await page.waitForSelector('.assistant-shell');
  await page.waitForFunction(() => typeof window.midgard.setKillExperienceRate === 'function' && typeof window.midgard.controlKillExperience === 'function' && typeof window.midgard.setKillExperiencePenalty === 'function');
}
const settle = (count = files.length) => wait(page, async count => { const state = await window.midgard.getState(); return state.live.streams.length === count && !state.live.activeWorkers && !state.live.queuedCount && state.live.streams.every(stream => stream.summary && stream.status === 'settled'); }, count, { timeout: 30000 });
async function goKill(key) {
  await page.getByRole('navigation', { name: 'Ana gezinme' }).getByRole('button', { name: 'Kill Count', exact: true }).click();
  if (key) await panel().getByRole('combobox', { name: 'Kill Count karakteri', exact: true }).selectOption(key);
}
async function rateUi(key, monsterId, baseExp, jobExp) {
  await goKill(key);
  let row = panel().locator(`[data-kill-exp-monster="${monsterId}"]`);
  if (!await row.count()) {
    await panel().getByLabel('Yaratık kimliği', { exact: true }).fill(String(monsterId));
    await panel().getByRole('button', { name: 'Yaratık ekle', exact: true }).click();
    await row.waitFor();
  }
  await row.getByLabel('Base EXP / yaratık', { exact: true }).fill(baseExp === null ? '' : String(baseExp));
  await row.getByLabel('Job EXP / yaratık', { exact: true }).fill(jobExp === null ? '' : String(jobExp));
  await row.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await wait(page, async ({ key, monsterId, baseExp, jobExp }) => { const character = (await window.midgard.getState()).expansion.killExperience.characters.find(character => character.characterKey === key); const rate = character?.rates.find(rate => rate.monsterId === monsterId); return rate?.baseExp === baseExp && rate?.jobExp === jobExp; }, { key, monsterId, baseExp, jobExp });
}
async function penaltyUi(key, percent) {
  await goKill(key);
  const choice = panel().getByRole('radio', { name: percent === 0 ? 'EXP kaybı kapalı' : `EXP kaybı %${percent}`, exact: true });
  await choice.check();
  await wait(page, async ({ key, percent }) => (await window.midgard.getState()).expansion.killExperience.characters.find(character => character.characterKey === key)?.deathPenaltyPercent === percent, { key, percent });
  assert(await choice.isChecked(), `Actual UI saves the ${percent}% death penalty for the chosen character`);
}
const expectedSnapshot = (file, bytes, packetCount) => ({ file: file.toLowerCase(), hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, packetCount });
async function waitParsed(expected) {
  await wait(page, async expected => { const state = await window.midgard.getState(); return expected.every(value => { const stream = state.live.streams.find(stream => stream.sourcePath.toLowerCase() === value.file); return stream?.contentHash === value.hash && stream.readPosition === value.size && stream.fileSize === value.size && stream.packetCount === value.packetCount; }); }, expected);
}
async function grow(index, extra) {
  packets[index].push(...extra, status(5, 10000)); const bytes = replay(index), handle = await open(files[index], 'r+');
  try { await handle.write(bytes.subarray(352), 0, bytes.length - 352, 352); await handle.write(bytes.subarray(0, 352), 0, 352, 0); await handle.sync(); } finally { await handle.close(); }
  await waitParsed([expectedSnapshot(files[index], bytes, packets[index].length)]);
}
async function waitSession(key, expected) {
  await wait(page, async ({ key, expected }) => { const session = (await window.midgard.getState()).expansion.killExperience.characters.find(character => character.characterKey === key)?.session; return !!session && Object.entries(expected).every(([name, value]) => session[name] === value); }, { key, expected });
}
async function invokeControl(index, action) { const input = controlInput(await stateOf(), index, action); return page.evaluate(input => window.midgard.controlKillExperience(input), input); }
async function screenshot(name) { const filename = `${name}.png`; await page.screenshot({ path: path.join(output, filename), fullPage: true }); screenshots.push(filename); }
async function theme(value) {
  await page.getByRole('button', { name: value === 'dark' ? 'Siyah tema' : 'Açık tema', exact: true }).click();
  await page.waitForFunction(expected => document.querySelector('.assistant-shell')?.getAttribute('data-theme') === expected, value);
}
try {
  await launch();
  await app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, files);
  await page.getByRole('button', { name: 'Dosya seç', exact: true }).first().click(); await settle();
  let state = await stateOf(); const a = sourceOf(state, 0).character.key, b = sourceOf(state, 3).character.key, c = sourceOf(state, 4).character.key;
  assert(sourceOf(state, 1).character.key === a && sourceOf(state, 2).character.key === a && a !== b, 'Three generated sources share character A while character B has its own identity');
  assert(state.live.streams.every(stream => state.expansion.experience[stream.id].base.current === null && state.expansion.experience[stream.id].job.current === null), 'Raw Replay EXP remains unknown in every generated death-only source');
  assert([a, b, c].every(key => estimateOf(state, key).deathPenaltyPercent === 0), 'Every character starts with death penalties disabled');
  await penaltyUi(a, 5); await penaltyUi(b, 10); await goKill(c);
  assert(await panel().getByRole('radio', { name: 'EXP kaybı kapalı', exact: true }).isChecked(), 'A third character retains its default disabled penalty independently of the others');
  for (const percent of [-5, 1, 100, '5']) {
    assert(await page.evaluate(async input => { try { await window.midgard.setKillExperiencePenalty(input); return false; } catch { return true; } }, { characterKey: a, percent }), `Penalty IPC rejects invalid percent ${JSON.stringify(percent)}`);
  }
  await rateUi(a, 1002, 100, 25); await rateUi(a, 1003, 0, null); await rateUi(b, 1002, 7, 3);
  state = await stateOf();
  assert(estimateOf(state, a).rates.find(rate => rate.monsterId === 1002).baseExp === 100 && estimateOf(state, b).rates.find(rate => rate.monsterId === 1002).baseExp === 7, 'Actual UI edits persist different Base and Job values for the same monster on two characters');
  assert(estimateOf(state, a).rates.find(rate => rate.monsterId === 1003).baseExp === 0 && estimateOf(state, a).rates.find(rate => rate.monsterId === 1003).jobExp === null, 'Actual UI editing preserves zero EXP separately from an empty unknown EXP field');
  await goKill(a);
  for (const invalid of ['-1', '1e3']) {
    const row = panel().locator('[data-kill-exp-monster="1002"]');
    await row.getByLabel('Base EXP / yaratık', { exact: true }).fill(invalid);
    await row.getByRole('button', { name: 'Kaydet', exact: true }).click();
    await row.getByRole('alert').waitFor({ state: 'visible' });
    assert(estimateOf(await stateOf(), a).rates.find(rate => rate.monsterId === 1002).baseExp === 100, `Actual UI rejects invalid EXP input ${invalid} and retains the saved value`);
  }
  await panel().locator('[data-kill-exp-monster="1002"]').getByLabel('Base EXP / yaratık', { exact: true }).fill('100');
  const rateInput = { characterKey: a, monsterId: 1002, baseExp: 100, jobExp: 25 };
  for (const [label, override] of [['negative EXP', { baseExp: -1 }], ['fractional EXP', { jobExp: 1.5 }], ['unsafe EXP', { baseExp: Number.MAX_SAFE_INTEGER + 1 }], ['text EXP', { baseExp: '100' }], ['zero monster ID', { monsterId: 0 }], ['unknown property', { untrusted: true }]]) {
    const rejected = await page.evaluate(async input => { try { await window.midgard.setKillExperienceRate(input); return false; } catch { return true; } }, { ...rateInput, ...override });
    assert(rejected, `IPC rejects ${label} without silently normalizing it`);
  }
  state = await stateOf(); assert(estimateOf(state, a).rates.find(rate => rate.monsterId === 1002).baseExp === 100, 'Rejected IPC edits leave saved rates unchanged');
  await goKill(a);
  const selector = panel().getByRole('combobox', { name: 'Tahmini EXP kaynağı', exact: true });
  assert(await selector.locator('option').count() === 4 && await selector.inputValue() === '' && await panel().getByRole('button', { name: 'Tahmini EXP başlat', exact: true }).isDisabled(), 'A character with three Replay sources requires explicit single-source selection');
  const selectedSource = sourceOf(state, 0);
  await selector.selectOption(JSON.stringify([selectedSource.id, state.expansion.experience[selectedSource.id].recordingId])); await panel().getByRole('button', { name: 'Tahmini EXP başlat', exact: true }).click(); await waitSession(a, { status: 'running', observedDeaths: 0 });
  await invokeControl(3, 'start'); await waitSession(b, { status: 'running', observedDeaths: 0 });
  assert(estimateOf(await stateOf(), a).session.base.gained === 0, 'Starting a measurement excludes all monster deaths already present in the Replay');
  const wrongSource = { ...controlInput(await stateOf(), 3, 'start'), characterKey: a };
  assert(await page.evaluate(async input => { try { await window.midgard.controlKillExperience(input); return false; } catch { return true; } }, wrongSource), 'IPC rejects a Replay source belonging to a different character');
  await grow(0, mobDeath(1100, 1002, 'QA Monster A', 42)); await grow(1, mobDeath(1100, 1002, 'QA Monster A', 42)); await grow(2, mobDeath(1100, 1002, 'QA Monster A', 42)); await grow(3, mobDeath(2100, 1002, 'QA Monster A', 43));
  await waitSession(a, { observedDeaths: 1 }); await waitSession(b, { observedDeaths: 1 }); await settle(); state = await stateOf();
  assert(estimateOf(state, a).session.base.gained === 100 && estimateOf(state, a).session.job.gained === 25 && estimateOf(state, b).session.base.gained === 7 && estimateOf(state, b).session.job.gained === 3, 'New monster observations use each character own configured Base and Job values');
  assert(estimateOf(state, a).session.streamId === sourceOf(state, 0).id && estimateOf(state, a).session.observedDeaths === 1, 'The same observed death in two other clients is ignored rather than combined three times');
  assert(estimateOf(state, a).session.durationMs > 0 && Math.abs(estimateOf(state, a).session.base.perHour - 100 * 3600000 / estimateOf(state, a).session.durationMs) < 0.001, 'Estimated hourly EXP uses only the selected measurement Replay duration');
  await page.waitForTimeout(2100); assert(estimateOf(await stateOf(), a).session.observedDeaths === 1, 'Unchanged watcher snapshots never repeat an estimated award');
  await rateUi(a, 1002, 200, 50); state = await stateOf(); assert(estimateOf(state, a).session.base.gained === 100 && estimateOf(state, a).session.job.gained === 25, 'Editing rates does not revalue awards already earned');
  await grow(0, mobDeath(1101, 1002, 'QA Monster A', 42)); await waitSession(a, { observedDeaths: 2 }); state = await stateOf();
  assert(estimateOf(state, a).session.base.gained === 300 && estimateOf(state, a).session.job.gained === 75, 'Only subsequent deaths receive the new 200 Base and 50 Job EXP rates');
  await grow(0, mobDeath(1102, 1003, 'QA Monster B', 42)); await waitSession(a, { observedDeaths: 3 }); state = await stateOf();
  assert(estimateOf(state, a).session.base.gained === 300 && estimateOf(state, a).session.base.missingDeaths === 0 && estimateOf(state, a).session.job.gained === null && estimateOf(state, a).session.job.knownGained === 75 && estimateOf(state, a).session.job.missingDeaths === 1, 'Configured zero Base EXP is complete while blank Job EXP creates an explicitly partial Job total');
  await grow(0, mobDeath(1103, 1004, 'QA Unknown Monster', 42)); await waitSession(a, { observedDeaths: 4 }); state = await stateOf();
  assert(estimateOf(state, a).session.base.gained === null && estimateOf(state, a).session.base.knownGained === 300 && estimateOf(state, a).session.base.missingDeaths === 1 && estimateOf(state, a).session.job.missingDeaths === 2, 'A completely unconfigured monster leaves missing EXP unknown instead of adding fabricated zero');
  await rateUi(a, 1003, 0, 10); await rateUi(a, 1004, 9, 4); state = await stateOf();
  assert(estimateOf(state, a).session.base.missingDeaths === 1 && estimateOf(state, a).session.job.missingDeaths === 2 && estimateOf(state, a).session.job.knownGained === 75, 'Filling a previously missing rate does not rewrite historical partial awards');
  await grow(0, mobDeath(1104, 1003, 'QA Monster B', 42)); await waitSession(a, { observedDeaths: 5 }); state = await stateOf();
  assert(estimateOf(state, a).session.base.knownGained === 300 && estimateOf(state, a).session.job.knownGained === 85, 'A future death uses the newly filled rate while earlier missing observations remain visible');
  await goKill(a); await panel().getByRole('button', { name: 'Tahmini EXP duraklat', exact: true }).click(); await waitSession(a, { status: 'paused' });
  const pausedDuration = estimateOf(await stateOf(), a).session.durationMs;
  await grow(0, mobDeath(1105, 1002, 'QA Monster A', 42)); await settle();
  assert(estimateOf(await stateOf(), a).session.observedDeaths === 5 && estimateOf(await stateOf(), a).session.durationMs === pausedDuration, 'Paused deaths and their Replay duration are excluded');
  await panel().getByRole('button', { name: 'Tahmini EXP sürdür', exact: true }).click(); await waitSession(a, { status: 'running' });
  assert(estimateOf(await stateOf(), a).session.observedDeaths === 5, 'Resuming baselines the paused gap without retroactive awards');
  await grow(0, mobDeath(1106, 1002, 'QA Monster A', 42)); await waitSession(a, { observedDeaths: 6 }); state = await stateOf();
  assert(estimateOf(state, a).session.base.knownGained === 500 && estimateOf(state, a).session.job.knownGained === 135, 'New observations after resume continue the same measurement totals');
  const previousId = estimateOf(state, a).session.id;
  await panel().getByRole('button', { name: 'Tahmini EXP sıfırla', exact: true }).click(); await waitSession(a, { status: 'running', observedDeaths: 0 }); state = await stateOf();
  assert(estimateOf(state, a).session.id !== previousId && estimateOf(state, a).session.base.gained === 0 && estimateOf(state, a).session.job.missingDeaths === 0 && estimateOf(state, a).rates.find(rate => rate.monsterId === 1002).baseExp === 200, 'Reset creates a clean measurement and retains all character-specific rate preferences');
  await grow(0, mobDeath(1107, 1002, 'QA Monster A', 42)); await waitSession(a, { observedDeaths: 1 }); await settle();
  const missing = `${files[0]}.temporarily-missing`; await rename(files[0], missing);
  await wait(page, async id => (await window.midgard.getState()).live.streams.find(stream => stream.id === id)?.status === 'missing', sourceOf(await stateOf(), 0).id);
  await waitSession(a, { status: 'source-unavailable' });
  state = await stateOf(); assert(estimateOf(state, a).session.base.gained === 200 && estimateOf(state, b).session.base.gained === 7, 'A missing selected source suspends its estimate and preserves other characters');
  packets[0].push(...mobDeath(1108, 1002, 'QA Unavailable Gap Monster', 42), status(5, 10000)); await writeFile(missing, replay(0)); await rename(missing, files[0]);
  await settle(); await waitSession(a, { status: 'running', observedDeaths: 1 });
  assert(estimateOf(await stateOf(), a).session.base.gained === 200, 'Restoring an unavailable source silently baselines deaths from the unobserved gap');
  await grow(0, mobDeath(1109, 1002, 'QA Monster A', 42)); await waitSession(a, { observedDeaths: 2 }); await settle(); state = await stateOf();
  assert(estimateOf(state, a).session.base.gained === 400 && estimateOf(state, a).session.job.gained === 100, 'A restored source awards only fresh observations after recovery');
  assert(sourceOf(state, 0).summary.liveTelemetry.currentBaseExp === null && state.expansion.experience[sourceOf(state, 0).id].base.current === null && state.expansion.experience[sourceOf(state, 0).id].base.expPerHour === null, 'Estimated XP never contaminates raw Replay current EXP or raw EXP per hour');
  await goKill(a); assert((await panel().locator('[data-kill-exp-summary]').innerText()).toLocaleLowerCase('tr-TR').includes('tahmini'), 'Kill Count measurement is visibly labeled as estimated');
  await page.getByRole('navigation', { name: 'Ana gezinme' }).getByRole('button', { name: /^Canlı takip/ }).click();
  const liveCard = page.locator(`[data-stream-id="${sourceOf(state, 0).id}"]`);
  assert(await liveCard.locator('[data-kill-exp-summary]').count() === 1 && (await liveCard.locator('[data-kill-exp-summary]').innerText()).toLocaleLowerCase('tr-TR').includes('tahmini'), 'The selected live character card includes the separately labeled estimated measurement');
  await goKill(a);
  const viewport = await page.context().newCDPSession(page);
  try {
    for (const mode of ['light', 'dark']) {
      await viewport.send('Emulation.clearDeviceMetricsOverride');
      await theme(mode);
      for (const width of [1480, 1100]) {
        await viewport.send('Emulation.clearDeviceMetricsOverride');
        await app.evaluate(({ BaseWindow }, width) => BaseWindow.getAllWindows()[0].setSize(width, 980), width);
        await page.waitForFunction(width => innerWidth >= width - 40 && innerWidth <= width, width);
        const actualWidth = await page.evaluate(() => innerWidth);
        assert(actualWidth >= width - 40 && actualWidth <= width, `${mode}: native ${width} pixel window has an actual ${actualWidth} pixel renderer viewport`);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${mode}: editable estimates fit the ${width} pixel desktop without page overflow`);
        await screenshot(`kill-exp-${mode}-${width}`);
      }
      await viewport.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
      await page.waitForFunction(() => innerWidth === 390);
      assert(await page.evaluate(() => innerWidth === 390 && document.documentElement.scrollWidth <= innerWidth), `${mode}: editable estimates fit the simulated 390 pixel viewport`);
      await screenshot(`kill-exp-${mode}-390-simulated`);
      await viewport.send('Emulation.clearDeviceMetricsOverride');
    }
  } finally {
    await viewport.send('Emulation.clearDeviceMetricsOverride');
    await viewport.detach();
  }
  const beforeRestart = { a: estimateOf(state, a).session, b: estimateOf(state, b).session };
  await app.close(); app = null; await launch(); await settle(); state = await stateOf();
  assert(estimateOf(state, a).session.id === beforeRestart.a.id && estimateOf(state, a).session.observedDeaths === 2 && estimateOf(state, a).session.base.gained === 400 && estimateOf(state, a).session.job.gained === 100 && estimateOf(state, b).session.base.gained === 7, 'Restart retains both measurements and never replays historical monster deaths');
  assert(estimateOf(state, a).rates.find(rate => rate.monsterId === 1002).baseExp === 200 && estimateOf(state, b).rates.find(rate => rate.monsterId === 1002).baseExp === 7, 'Restart restores independent per-character monster EXP preferences');
  assert(estimateOf(state, a).deathPenaltyPercent === 5 && estimateOf(state, b).deathPenaltyPercent === 10 && estimateOf(state, c).deathPenaltyPercent === 0, 'Restart restores independent 5%, 10% and disabled death penalty preferences');
  await grow(0, mobDeath(1110, 1002, 'QA Monster A', 42)); await waitSession(a, { observedDeaths: 3 });
  assert(estimateOf(await stateOf(), a).session.base.gained === 600, 'A restarted measurement continues from a fresh source baseline without losing its saved totals');
  await goKill(a); await panel().getByRole('button', { name: 'Tahmini EXP durdur', exact: true }).click(); await waitSession(a, { status: 'stopped' });
  await grow(0, mobDeath(1111, 1002, 'QA Stopped Monster', 42)); await settle();
  assert(estimateOf(await stateOf(), a).session.observedDeaths === 3 && estimateOf(await stateOf(), a).session.base.gained === 600, 'Stopping freezes the finished measurement even while its Replay keeps growing');
  await invokeControl(0, 'reset'); await invokeControl(3, 'reset'); await invokeControl(4, 'start');
  await waitSession(a, { status: 'running', observedDeaths: 0 }); await waitSession(b, { status: 'running', observedDeaths: 0 }); await waitSession(c, { status: 'running', observedDeaths: 0 });
  state = await stateOf();
  const rawA = state.expansion.experience[sourceOf(state, 0).id], rawB = state.expansion.experience[sourceOf(state, 3).id];
  assert(rawA.base.level === 40 && rawA.job.level === 20 && [rawA.base.required, rawA.job.required, rawB.base.required, rawB.job.required].every(value => Number.isSafeInteger(value) && value > 0), 'Death penalty fixtures use supported requirements at the latest packet levels, rather than older Session levels');
  const base5 = penaltyAmount(rawA.base.required, 5), job5 = penaltyAmount(rawA.job.required, 5), base10 = penaltyAmount(rawA.base.required, 10), job10 = penaltyAmount(rawA.job.required, 10);
  const bBase10 = penaltyAmount(rawB.base.required, 10), bJob10 = penaltyAmount(rawB.job.required, 10);
  await grow(0, [vanish(42), vanish(42), vanish(9999)]); await grow(1, [vanish(42)]); await grow(2, [vanish(42)]); await grow(3, [vanish(43)]); await grow(4, [vanish(44)]);
  await waitSession(a, { observedPlayerDeaths: 1 }); await waitSession(b, { observedPlayerDeaths: 1 }); await waitSession(c, { observedPlayerDeaths: 1 }); await settle(); state = await stateOf();
  assert(estimateOf(state, a).session.base.lost === base5 && estimateOf(state, a).session.job.lost === job5 && estimateOf(state, a).session.base.net === -base5 && estimateOf(state, a).session.job.net === -job5, 'A confirmed owner death subtracts floor 5% of both current level requirements and allows negative estimated net EXP');
  assert(estimateOf(state, b).session.base.lost === bBase10 && estimateOf(state, b).session.job.lost === bJob10, 'Another character uses its independent 10% Base and Job loss settings');
  assert(estimateOf(state, c).session.base.lost === 0 && estimateOf(state, c).session.job.lost === 0 && estimateOf(state, c).session.base.net === 0 && estimateOf(state, c).session.job.net === 0, 'A real generated owner death makes no deduction when that character penalty is disabled');
  assert(estimateOf(state, a).session.observedPlayerDeaths === 1 && estimateOf(state, a).session.observedDeaths === 0, 'Repeated owner-death packets, other actor deaths and two copied client observations do not create additional losses or monster awards');
  await page.waitForTimeout(2100); state = await stateOf();
  assert(estimateOf(state, a).session.base.lost === base5 && estimateOf(state, a).session.observedPlayerDeaths === 1, 'Repeated unchanged snapshots never deduct the same owner death twice');
  await goKill(a);
  assert(await panel().locator('[data-kill-exp-metric="base-lost"]').innerText() !== '—' && await panel().locator('[data-kill-exp-metric="job-lost"]').innerText() !== '—' && await panel().locator('[data-kill-exp-metric="player-deaths"]').innerText() === '1' && (await panel().locator('[data-kill-exp-summary]').innerText()).includes('Net EXP / saat'), 'The estimated summary exposes both losses, player death count and net hourly labels');
  await penaltyUi(a, 10); state = await stateOf();
  assert(estimateOf(state, a).session.base.lost === base5 && estimateOf(state, a).session.job.lost === job5 && estimateOf(state, b).deathPenaltyPercent === 10 && estimateOf(state, c).deathPenaltyPercent === 0, 'Changing 5% to 10% affects only future deaths and preserves other character settings');
  await grow(0, [resurrect(42), vanish(42)]); await waitSession(a, { observedPlayerDeaths: 2 }); state = await stateOf();
  assert(estimateOf(state, a).session.base.lost === base5 + base10 && estimateOf(state, a).session.job.lost === job5 + job10, 'A source-defined resurrection re-arms one subsequent owner death with the new 10% penalty');
  await grow(0, mobDeath(1200, 1002, 'QA Monster After Penalty', 42)); await waitSession(a, { observedDeaths: 1 }); state = await stateOf();
  const penaltySession = estimateOf(state, a).session;
  assert(penaltySession.base.gained === 200 && penaltySession.job.gained === 50 && penaltySession.base.lost === base5 + base10 && penaltySession.job.lost === job5 + job10, 'A monster death adds configured EXP without charging another player-death penalty');
  assert(penaltySession.base.net === 200 - base5 - base10 && penaltySession.job.net === 50 - job5 - job10 && Math.abs(penaltySession.base.perHour - penaltySession.base.net * 3600000 / penaltySession.durationMs) < 0.001, 'Estimated net totals and hourly rates subtract accumulated losses exactly once');
  assert(state.expansion.experience[sourceOf(state, 0).id].base.current === null && state.expansion.experience[sourceOf(state, 0).id].job.current === null, 'Estimated death deductions keep actual Replay Base and Job EXP unknown');
  await goKill(a); await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setSize(1100, 980)); await page.waitForFunction(() => innerWidth >= 1060 && innerWidth <= 1100);
  await screenshot('kill-exp-penalty-1100');
  await page.getByRole('button', { name: 'Finans', exact: true }).click(); assert(await page.locator('.auto-finance').count() === 1, 'Existing automatic Finance remains accessible');
  await page.getByRole('button', { name: 'Bildirim ayarları', exact: true }).click(); assert(await page.getByRole('button', { name: 'Karakter öldüğünde sesini dene', exact: true }).count() === 1, 'Existing sound notification controls remain accessible');
  const saved = JSON.parse(await readFile(path.join(profile, 'live-preferences.json'), 'utf8'));
  assert(saved.alerts.volume === 43 && saved.alerts.muted && saved.alerts.weightThreshold === 67 && saved.alerts.selectedCardIds.join() === '4317' && saved.soundPaths.card === sound, 'The isolated profile retains sound path, mute, volume, selected cards and weight preferences');

  // A separate phase preserves the single-source checks above. Cross-Replay
  // matching below is deliberately an estimate, never a unique server kill ID.
  const partyNames = ['QA Party Çağrı', 'QA Party İpek', 'QA Party Özgür'], partyPlayers = [142, 143, 144];
  const partyFiles = partyNames.map((_, index) => path.join(sources, `SYNTHETIC-party-exp-${index + 1}.rrf`));
  const partyPackets = partyNames.map((_, index) => [...noExpBaseline(), ...Array.from({ length: 65 }, () => status(5, 10000)), ...mobDeath(4900, 1002, 'QA Party Historical Monster', partyPlayers[index])]);
  const partyTimes = partyNames.map(() => new Map());
  const partyReplay = index => {
    const bytes = assistanceReplay({ character: partyNames[index], player: partyPlayers[index], jobClassId: 8, baseLevel: 30, jobLevel: 10, packets: partyPackets[index] });
    let cursor = 352;
    for (let packet = 0; packet < partyPackets[index].length; packet++) {
      if (partyTimes[index].has(packet)) bytes.writeInt32LE(partyTimes[index].get(packet), cursor + 4);
      cursor += 10 + partyPackets[index][packet].length;
    }
    return bytes;
  };
  const partySource = (value, index) => value.live.streams.find(stream => path.resolve(stream.sourcePath).toLowerCase() === partyFiles[index].toLowerCase());
  const totalSources = files.length + partyFiles.length;
  for (let index = 0; index < partyFiles.length; index++) await writeFile(partyFiles[index], partyReplay(index));
  await page.getByRole('navigation', { name: 'Ana gezinme' }).getByRole('button', { name: /^Canlı takip/ }).click();
  await app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, partyFiles);
  await page.getByRole('button', { name: 'Dosya seç', exact: true }).first().click(); await settle(totalSources); state = await stateOf();
  const partyKeys = partyNames.map((_, index) => partySource(state, index).character.key);
  assert(new Set(partyKeys).size === 3, 'Party fixtures expose three different character identities with one selected source each');
  for (let member = 0; member < partyKeys.length; member++) {
    for (let monster = 0; monster < 3; monster++) await rateUi(partyKeys[member], 1002 + monster, (monster + 1) * 100 + member * 10, (monster + 1) * 10 + member);
  }
  await penaltyUi(partyKeys[0], 5); await penaltyUi(partyKeys[1], 10);
  await goKill(partyKeys[0]);
  const primaryPartyMember = panel().getByRole('checkbox', { name: `Party karakteri: ${partyNames[0]}`, exact: true });
  assert(await primaryPartyMember.isChecked() && await primaryPartyMember.isDisabled(), 'The selected character is the explicit primary party member');
  await panel().getByRole('checkbox', { name: `Party karakteri: ${partyNames[1]}`, exact: true }).check();
  await panel().getByRole('checkbox', { name: `Party karakteri: ${partyNames[2]}`, exact: true }).check();
  state = await stateOf();
  for (let member = 0; member < partyKeys.length; member++) {
    const stream = partySource(state, member), label = member === 0 ? 'Tahmini EXP kaynağı' : `Party Replay: ${partyNames[member]}`;
    await panel().getByRole('combobox', { name: label, exact: true }).selectOption(JSON.stringify([stream.id, state.expansion.experience[stream.id].recordingId]));
  }
  await panel().getByRole('button', { name: 'Party olarak başlat', exact: true }).click();
  const partySessions = value => partyKeys.map(key => estimateOf(value, key).session);
  async function waitParty(expected) {
    await wait(page, async ({ keys, expected }) => { const state = await window.midgard.getState(); return keys.every(key => { const session = state.expansion.killExperience.characters.find(character => character.characterKey === key)?.session; return session?.mode === 'party' && Object.entries(expected).every(([name, value]) => session[name] === value); }); }, { keys: partyKeys, expected });
  }
  async function advanceParty(extra, destinations = partyFiles, stepMs = 1000, waitForIngest = true) {
    const largest = Math.max(...extra.map(packets => packets.length)), expected = [];
    for (let member = 0; member < partyFiles.length; member++) {
      const previousCount = partyPackets[member].length, previousTime = partyTimes[member].get(previousCount - 1) ?? (previousCount - 1) * 1000;
      partyPackets[member].push(...extra[member], ...Array.from({ length: largest - extra[member].length }, () => status(5, 10000)), status(5, 10000));
      for (let packet = previousCount; packet < partyPackets[member].length; packet++) partyTimes[member].set(packet, previousTime + (packet - previousCount + 1) * stepMs);
      const bytes = partyReplay(member), handle = await open(destinations[member], 'r+');
      try { await handle.write(bytes.subarray(352), 0, bytes.length - 352, 352); await handle.write(bytes.subarray(0, 352), 0, 352, 0); await handle.sync(); } finally { await handle.close(); }
      if (destinations[member] === partyFiles[member]) expected.push(expectedSnapshot(partyFiles[member], bytes, partyPackets[member].length));
    }
    if (waitForIngest) await waitParsed(expected);
  }
  const commonMonster = aid => partyPlayers.map(player => mobDeath(aid, 1002, 'QA Shared Party Monster', player));
  await waitParty({ status: 'running', observedDeaths: 0 }); state = await stateOf();
  assert(partySessions(state).every(session => session.sources.length === 3 && session.groupId === partySessions(state)[0].groupId) && !!partySessions(state)[0].groupId, 'One actual UI party start creates three linked character measurements with fixed three-source membership');
  assert(partySessions(state).every(session => session.base.gained === 0 && session.estimatedDeaths === 0), 'Starting a party excludes all historical deaths in the three files');
  await advanceParty(commonMonster(5000)); await waitParty({ observedDeaths: 1 }); await settle(totalSources); state = await stateOf();
  assert(partySessions(state).every((session, member) => session.base.gained === 100 + member * 10 && session.job.gained === 10 + member), 'Every member receives its own configured XP for one shared observed monster');
  assert(partySessions(state).every(session => session.rawObservations === 3 && session.duplicateCandidates === 2 && session.estimatedDeaths === 1 && session.matchingWindowMs === 1500), 'Three matching observations are presented as one estimated death plus two duplicate candidates');
  assert(partySessions(state).every(session => session.durationMs === 4000 && Math.abs(session.base.perHour - session.base.gained * 3600000 / 4000) < 0.001), 'Three parallel four-second source intervals contribute four seconds once, rather than twelve seconds of character time');
  assert(partySessions(state).every(session => session.coverage.availableSources === 3 && session.coverage.totalSources === 3 && !session.coverage.partial), 'Party coverage reports all three selected sources available');
  await page.waitForTimeout(2100); assert(partySessions(await stateOf()).every(session => session.observedDeaths === 1), 'Rereading common party observations does not award the pool again');
  await goKill(partyKeys[0]);
  assert((await panel().locator('[data-kill-exp-summary]').innerText()).toLocaleLowerCase('tr-TR').includes('party') && (await panel().locator('[data-kill-exp-summary]').innerText()).toLocaleLowerCase('tr-TR').includes('tahmini'), 'The shared-pool UI explicitly identifies party results as estimates');
  assert(await panel().locator('[data-kill-exp-mode="party"]').count() === 1 && await panel().locator('[data-kill-exp-metric="party-raw"]').innerText() === '3' && await panel().locator('[data-kill-exp-metric="party-duplicates"]').innerText() === '2' && (await panel().locator('[data-kill-exp-metric="party-coverage"]').innerText()).replace(/\s/g, '') === '3/3', 'The party summary exposes raw observations, duplicate candidates and source coverage separately');
  await screenshot('kill-exp-party-common');
  await goKill('all');
  assert(await panel().locator('[aria-label="Party EXP sonuçları"] [data-kill-exp-mode="party"]').count() === 3, 'The all-character view exposes three separate party result cards');
  await goKill(partyKeys[0]);
  await panel().getByRole('button', { name: 'Tahmini EXP sıfırla', exact: true }).click(); await waitParty({ status: 'running', observedDeaths: 0 });
  await advanceParty(partyPlayers.map((player, member) => mobDeath(5010 + member, 1002 + member, 'QA Distinct Party Monster', player)));
  await waitParty({ observedDeaths: 3 }); await settle(totalSources); state = await stateOf();
  assert(partySessions(state).every((session, member) => session.base.gained === 600 + member * 30 && session.job.gained === 60 + member * 3 && session.estimatedDeaths === 3), 'Three different monsters across three characters form a three-death pool valued independently for every member');
  const partyRaw = state.expansion.experience[partySource(state, 0).id], partyBaseLoss = penaltyAmount(partyRaw.base.required, 5), partyJobLoss = penaltyAmount(partyRaw.job.required, 5);
  await advanceParty([[vanish(142), vanish(142)], [vanish(142)], [vanish(142)]]);
  await waitSession(partyKeys[0], { observedPlayerDeaths: 1 }); await settle(totalSources); state = await stateOf();
  assert(partySessions(state)[0].base.lost === partyBaseLoss && partySessions(state)[0].job.lost === partyJobLoss && partySessions(state).slice(1).every(session => session.observedPlayerDeaths === 0 && session.base.lost === 0 && session.job.lost === 0), 'A member death deducts only that owner penalty even when the other two clients also observe the disappearing actor');
  assert(partySessions(state).every(session => session.observedDeaths === 3), 'An owner death never becomes a shared monster award');
  await goKill(partyKeys[0]); await panel().getByRole('button', { name: 'Tahmini EXP duraklat', exact: true }).click(); await waitParty({ status: 'paused' });
  const pausedParty = partySessions(await stateOf()).map(session => ({ id: session.id, durationMs: session.durationMs }));
  await advanceParty(commonMonster(5020), partyFiles, 1000, false); state = await stateOf();
  assert(partySessions(state).every((session, member) => session.observedDeaths === 3 && session.durationMs === pausedParty[member].durationMs), 'Pausing one party measurement pauses the linked pool and excludes gap deaths and duration for every member');
  await panel().getByRole('button', { name: 'Tahmini EXP sürdür', exact: true }).click(); await waitParty({ status: 'running', observedDeaths: 3 });
  await waitParsed(partyFiles.map((file, member) => expectedSnapshot(file, partyReplay(member), partyPackets[member].length)));
  assert(partySessions(await stateOf()).every(session => session.observedDeaths === 3), 'Resume synchronizes newly written paused sources before baselining, so an unread paused death is not awarded');
  await advanceParty(commonMonster(5021)); await waitParty({ observedDeaths: 4 }); await settle(totalSources); state = await stateOf();
  assert(partySessions(state).every((session, member) => session.base.gained === 700 + member * 40 && session.job.gained === 70 + member * 4), 'Resuming a party skips paused history and awards only the next common death');
  const persistentParty = partySessions(state).map(session => ({ id: session.id, groupId: session.groupId, base: session.base.gained, job: session.job.gained, lost: session.base.lost }));
  await app.close(); app = null; await launch(); await settle(totalSources); await waitParty({ status: 'running', observedDeaths: 4 }); state = await stateOf();
  assert(partySessions(state).every((session, member) => session.id === persistentParty[member].id && session.groupId === persistentParty[member].groupId && session.base.gained === persistentParty[member].base && session.job.gained === persistentParty[member].job && session.base.lost === persistentParty[member].lost && session.sources.length === 3), 'Restart preserves the linked party membership, gains and owner-only loss without replaying its history');
  await advanceParty(commonMonster(5022)); await waitParty({ observedDeaths: 5 }); await settle(totalSources);
  assert(partySessions(await stateOf()).every((session, member) => session.base.gained === 800 + member * 50), 'The restored party continues from fresh per-source baselines');
  const absentPartyFile = `${partyFiles[2]}.temporarily-missing`; await rename(partyFiles[2], absentPartyFile);
  await wait(page, async keys => { const state = await window.midgard.getState(); return keys.every(key => { const session = state.expansion.killExperience.characters.find(character => character.characterKey === key)?.session; return session?.coverage.partial && session.coverage.availableSources === 2 && session.coverage.totalSources === 3; }); }, partyKeys);
  assert(partySessions(await stateOf()).every(session => session.status === 'running'), 'One missing party source leaves the two available sources active with explicitly partial coverage');
  await goKill(partyKeys[2]); await panel().getByRole('button', { name: 'Tahmini EXP duraklat', exact: true }).click(); await waitParty({ status: 'paused', observedDeaths: 5 });
  await panel().getByRole('button', { name: 'Tahmini EXP sürdür', exact: true }).click(); await waitParty({ status: 'running', observedDeaths: 5 }); state = await stateOf();
  assert(partySource(state, 2).status === 'missing' && partySessions(state).every(session => session.coverage.partial && session.coverage.availableSources === 2 && session.coverage.totalSources === 3), 'The missing member own card can pause and resume its party through the two healthy sources without changing counts');
  await advanceParty([mobDeath(5023, 1002, 'QA Available Party Monster', 142), [], mobDeath(5024, 1002, 'QA Unobserved Gap Monster', 144)], [partyFiles[0], partyFiles[1], absentPartyFile]);
  await waitParty({ observedDeaths: 6 }); state = await stateOf();
  assert(partySessions(state).every((session, member) => session.base.gained === 900 + member * 60 && session.coverage.partial), 'Available sources continue the shared estimated pool for all members while the missing file own unseen death is excluded');
  await rename(absentPartyFile, partyFiles[2]); await settle(totalSources);
  await wait(page, async keys => { const state = await window.midgard.getState(); return keys.every(key => { const session = state.expansion.killExperience.characters.find(character => character.characterKey === key)?.session; return session?.coverage.availableSources === 3 && !session.coverage.partial; }); }, partyKeys);
  assert(partySessions(await stateOf()).every(session => session.observedDeaths === 6), 'Recovering a missing party source baselines its unseen gap without retroactive awards');
  await advanceParty(commonMonster(5025)); await waitParty({ observedDeaths: 7 }); await settle(totalSources);
  await advanceParty(commonMonster(5025)); await waitParty({ observedDeaths: 8 }); await settle(totalSources); state = await stateOf();
  assert(partySessions(state).every((session, member) => session.base.gained === 1100 + member * 80), 'A later respawn of the same actor counts as a new observation while each three-client sighting still counts once');
  assert(partyKeys.every((_, member) => { const exp = state.expansion.experience[partySource(state, member).id]; return exp.base.current === null && exp.job.current === null && exp.base.expPerHour === null; }), 'Party estimates never overwrite measured Replay EXP fields');
  await goKill(partyKeys[0]); await screenshot('kill-exp-party-recovered');
  await panel().getByRole('button', { name: 'Tahmini EXP sıfırla', exact: true }).click(); await waitParty({ status: 'running', observedDeaths: 0 }); state = await stateOf();
  assert(partySessions(state).every(session => session.sources.length === 3 && session.base.gained === 0 && session.base.lost === 0) && partyKeys.every((key, member) => estimateOf(state, key).rates.find(rate => rate.monsterId === 1002).baseExp === 100 + member * 10 && estimateOf(state, key).deathPenaltyPercent === [5, 10, 0][member]), 'Reset clears the whole party measurement while retaining fixed membership, per-character XP and penalty preferences');
  await advanceParty(partyPlayers.map(player => [...mobDeath(5027, 1002, 'QA Rapid Respawn Monster', player), ...mobDeath(5027, 1002, 'QA Rapid Respawn Monster', player)]), partyFiles, 150);
  await waitParty({ observedDeaths: 2 }); await settle(totalSources); state = await stateOf();
  assert(partySessions(state).every((session, member) => session.base.gained === 200 + member * 20 && session.rawObservations === 6 && session.duplicateCandidates === 4 && session.estimatedDeaths === 2), 'Two same-source lifecycles only 450ms apart remain two estimated deaths while matching copies from three clients are removed');
  await panel().getByRole('button', { name: 'Tahmini EXP durdur', exact: true }).click(); await waitParty({ status: 'stopped' });
  await advanceParty(commonMonster(5026)); await settle(totalSources);
  assert(partySessions(await stateOf()).every((session, member) => session.observedDeaths === 2 && session.base.gained === 200 + member * 20), 'Stopping one linked party measurement freezes all member measurements');
  assert(!errors.length, 'No renderer errors occur');
  const report = { passed: checks.length, checks, errors, screenshots, fixture: 'Eight generated Replay sources cover three views of one character, two independent single-source characters, three separate party members, monster deaths, owner deaths and source-defined 0x0148 resurrection packets; one isolated MIDGARD_USER_DATA profile. No real game recordings copied or game windows captured.', limits: 'This proves user-configured XP estimates and optional 0/5/10% owner-death deductions. Cross-Replay party matching is approximate, using map/actor/monster and a 1500ms clock window; it does not prove a unique server death, personal kill ownership or measured Skadi EXP. Raw EXP remains unknown. The 390px layout is a renderer viewport simulation. Physical audio and NSIS install flow are not tested.', executable: process.argv[2] ? path.resolve(process.argv[2]) : 'source electron .' };
  await writeFile(path.join(output, 'kill-exp-ui-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, ...report }, null, 2));
} catch (error) {
  let diagnostic;
  try {
    const state = await stateOf();
    diagnostic = { streams: state.live?.streams.map(stream => ({ id: stream.id, filename: stream.filename, status: stream.status, revision: stream.revision, fileSize: stream.fileSize, readPosition: stream.readPosition, packetCount: stream.packetCount, contentHash: stream.contentHash })), estimates: state.expansion?.killExperience };
  } catch {}
  await writeFile(path.join(output, 'kill-exp-ui-failure.json'), JSON.stringify({ checks, errors, failure: String(error), stack: error?.stack, diagnostic }, null, 2));
  try { await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); } catch {}
  throw error;
} finally { await app?.close(); }
