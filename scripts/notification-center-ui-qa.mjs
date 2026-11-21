import {_electron as electron} from 'playwright';
import {mkdir, writeFile, open} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {assistanceReplay, bagBaseline, verifiedItemReceipt} from './auto-farm-fixtures.mjs';
import {mapChange} from './assistance-fixtures.mjs';
import {mobDeath} from './kill-count-fixtures.mjs';
import {wait} from './qa-wait.mjs';

const directory = path.resolve('.qa', 'notification-center-' + Date.now());
const profile = path.join(directory, 'profile'), sources = path.join(directory, 'sources');
await Promise.all([profile, sources].map(folder => mkdir(folder, {recursive:true})));
const file = path.join(sources, 'SYNTHETIC-alert-center.rrf');
const packets = bagBaseline();
function replay() {
  const bytes = assistanceReplay({character:'QA Merkez', player:42, packets});
  // The fixture header declares a 60-second recording. Fresh events must advance beyond it.
  let offset = bytes.readInt32LE(118);
  for (const [index, packet] of packets.entries()) {
    bytes.writeInt32LE(60000 + index * 1000, offset + 4);
    offset += 10 + packet.length;
  }
  return bytes;
}
await writeFile(file, replay());
await writeFile(path.join(profile, 'live-preferences.json'), JSON.stringify({
  version:1, sources:[file], manualBindings:[], soundPaths:{},
  alerts:{enabled:{card:false, monster:false, city:false}, selectedCardIds:[4317,603], selectedMonsterIds:[1313], cityMaps:['prontera'], volume:32, muted:true},
}));
const env = {...process.env, MIDGARD_USER_DATA:profile};
delete env.ELECTRON_RUN_AS_NODE;
delete env.MIDGARD_DEV_URL;
const executable = process.argv[2] && path.resolve(process.argv[2]);
const errors = [];
let app, page;
async function launch() {
  const args = ['--mute-audio', '--replace-live-sources', '--live-file=' + file];
  app = await electron.launch(executable ? {executablePath:executable, args, env} : {args:['.', ...args], env});
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('navigation', {name:'Ana gezinme'}).waitFor();
  await page.evaluate(() => {
    window.qaNotices = [];
    window.midgard.onNotification(event => window.qaNotices.push(event));
    window.qaRare = [];
    window.midgard.onRareDrop(event => window.qaRare.push(event));
  });
  await wait(page, async () => (await window.midgard.getState()).live.streams.some(stream => stream.summary));
}
const button = name => page.getByRole('button', {name, exact:true});
const center = () => button('Bildirim ayarları').click();
async function add(type, field, value) {
  await button(type).click();
  const input = page.getByRole('textbox', {name:field, exact:true});
  await input.fill(value);
  await input.press('Enter');
  await page.waitForFunction(() => document.querySelector('.notice-hint')?.textContent.includes('bildirimi açıldı'));
}
async function grow(batch) {
  packets.push(...batch);
  const bytes = replay();
  const handle = await open(file, 'r+');
  try {
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.truncate(bytes.length);
    await handle.sync();
  } finally {await handle.close();}
}
const prefs = () => page.evaluate(async () => (await window.midgard.getState()).assistance.preferences);
try {
  await launch();
  await center();
  assert.equal(await page.getByRole('heading', {level:1}).innerText(), 'Bildirim merkezi');
  assert.deepEqual(await page.getByRole('switch').evaluateAll(xs=>xs.map(el=>el.getAttribute('aria-label'))),
    ['Eşya','Yaratık ölümü','Çanta ağırlığı','Harita değişimi','Karakter ölümü']);
  assert.equal(await page.locator('.notice-detail:visible').count(), 0);
  assert.equal(await button('Sessiz mod').getAttribute('aria-pressed'), 'false');
  await page.screenshot({path:path.join(directory, 'center-light.png')});
  await button('Siyah tema').click();
  await page.screenshot({path:path.join(directory, 'center-dark.png')});
  await page.setViewportSize({width:390, height:840});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path:path.join(directory, 'center-narrow.png'), fullPage:true});
  await page.setViewportSize({width:1280, height:900});
  await add('Eşya', 'Eşya adı veya kimliği', '#501');
  let settings = await prefs();
  assert.ok(settings.enabled.card && settings.selectedCardIds.includes(501) && settings.muted && settings.volume === 32);
  const input = page.getByRole('textbox', {name:'Eşya adı veya kimliği'});
  await input.fill('#501'); await input.press('Enter');
  await page.getByText(/bildirimi zaten açık/).waitFor();
  assert.equal((await prefs()).selectedCardIds.filter(id => id === 501).length, 1);
  await input.fill('4294967296'); await input.press('Enter');
  assert.ok(!(await prefs()).selectedCardIds.includes(4294967296));
  await input.fill('Mobster Card'); await input.press('Enter');
  await page.locator('.notice-composer').getByText(/Bu kartı Kart ve kostüm sesleri/).waitFor();
  await page.locator('[aria-controls="rare-sounds-card"]').click();
  await page.locator('#rare-sounds-card').getByRole('button',{name:'Mobster Card eski eşya hedefini kaldır'}).waitFor();
  await page.locator('[aria-controls="rare-sounds-card"]').click();
  await add('Yaratık', 'Yaratık adı veya kimliği', 'Mobster');
  assert.ok((await prefs()).enabled.monster);
  await add('Harita', 'Harita kimliği', 'PRT_FILD08.gat');
  assert.deepEqual((await prefs()).cityMaps, ['prontera', 'prt_fild08']);
  await add('Eşya', 'Eşya adı veya kimliği', 'Glass Bead');
  settings = await prefs();
  assert.ok(settings.selectedCardIds.includes(746));
  await page.locator('.notice-disclosure').filter({hasText:'Çanta ağırlığı'}).click();
  const duration=page.getByRole('spinbutton',{name:'Çanta ağırlığı sahne süresi (saniye)'});
  const saveDuration=button('Çanta ağırlığı süresini kaydet');
  assert.equal(await duration.inputValue(),'5');
  await duration.fill('61');
  assert.ok(await saveDuration.isDisabled());
  await duration.fill('8');
  await saveDuration.click();
  await wait(page,async()=>(await window.midgard.getState()).assistance.sceneDurations.weight===8);
  await page.getByRole('spinbutton', {name:'Ağırlık eşiği (%)'}).fill('72');
  await button('Uygula').click();
  await wait(page, async () => (await window.midgard.getState()).assistance.preferences.weightThreshold === 72);
  await button('Karaktere özel ayarlar').click();
  await page.getByRole('spinbutton', {name:'Karakter ağırlık eşiği'}).fill('68');
  await button('Karakter ayarlarını uygula').click();
  await wait(page, async () => Object.values((await window.midgard.getState()).expansion.alertPreferences).some(value => value.legacy.weightThreshold === 68 && value.legacy.selectedCardIds === undefined));
  const extras=page.getByRole('textbox', {name:'Bu karaktere ek eşya kimlikleri'});
  await extras.fill('4317'); await button('Karakter ayarlarını uygula').click();
  await page.getByText(/Kart ve kostüm seslerini yukarıdaki/).waitFor();
  await extras.fill('909');
  await page.getByRole('checkbox', {name:'Old Blue Box', exact:true}).uncheck();
  await button('Karakter ayarlarını uygula').click();
  await wait(page, async () => Object.values((await window.midgard.getState()).expansion.alertPreferences).some(value => value.legacy.selectedCardIds?.join() === '909' && value.legacy.enabled?.['old-blue-box'] === false));
  await add('Eşya', 'Eşya adı veya kimliği', '#972');
  await app.evaluate(({BaseWindow}) => BaseWindow.getAllWindows()[0].blur());
  await grow(verifiedItemReceipt(972, 3, 8));
  await wait(page, () => window.qaNotices.some(event => event.type === 'card' && event.itemId === 972 && event.amount === 3));
  await page.locator('[aria-controls="notice-card"]').click();
  const ordinary=page.locator('#notice-card');
  await ordinary.getByRole('group',{name:'Old Blue Box sesi'}).getByRole('button',{name:'Ganimet çanı'}).waitFor();
  assert.equal(await ordinary.getByRole('button',{name:'Mobster Card hedefini kaldır'}).count(),0);
  await page.locator('#notice-card .notice-chips button').filter({hasText:/972|Karvodailnirol/i}).click();
  await wait(page, async () => !(await window.midgard.getState()).assistance.preferences.selectedCardIds.includes(972));
  const card=verifiedItemReceipt(4317, 1, 9, 60020);
  card[1][33]=6;
  await grow([...verifiedItemReceipt(972, 4, 8, 60010), ...card, mapChange('prt_fild07')]);
  await wait(page, () => window.qaRare.some(event => event.category === 'card' && event.itemId === 4317 && event.quantity === 1));
  assert.equal(await page.evaluate(() => window.qaNotices.filter(event => event.itemId === 972).length), 1);
  assert.equal(await page.evaluate(() => window.qaNotices.filter(event => event.itemId === 4317).length), 0);
  await grow([...verifiedItemReceipt(501, 2, 7, 60030), mapChange('prt_fild08'), ...mobDeath(5001,1313,'Mobster',42)]);
  await wait(page, () => window.qaNotices.some(event => event.type === 'card' && event.itemId === 501 && event.amount === 2));
  await wait(page, () => window.qaNotices.some(event => event.type === 'city') && window.qaNotices.some(event => event.type === 'monster' && event.monsterId === 1313));
  assert.equal(await page.evaluate(() => window.qaNotices.filter(event => event.itemId === 501).length), 1);
  await page.locator('.assistant-flash').filter({hasText:'#501'}).waitFor();
  await button('Finans').click();
  await page.getByRole('group', {name:'Finans dönemi'}).getByRole('button', {name:'Tümü'}).click();
  await page.locator('.finance-heading').getByText(/3 eşya türü/).waitFor();
  await page.getByRole('textbox', {name:'Eşya adı veya ID ara'}).fill('501');
  await page.locator('tr[data-farm-item-id="501"] .finance-item-link').click();
  await button('Eşya bildirimi açık').click();
  await button('Bu eşya için bildirim ekle').click();
  await button('Eşya bildirimi açık').waitFor();
  await app.close(); app = null;
  await launch();
  settings = await prefs();
  assert.ok(settings.enabled.card && settings.enabled.monster && settings.enabled.city);
  assert.deepEqual(settings.selectedCardIds, [4317,603,746,501]);
  assert.equal(await page.evaluate(async()=>(await window.midgard.getState()).assistance.sceneDurations.weight),8);
  assert.ok(settings.weightThreshold === 72 && settings.volume === 32 && settings.muted);
  assert.equal(await page.evaluate(() => window.qaNotices.length), 0);
  await center();
  await page.locator('[aria-controls="notice-card"]').click();
  await page.locator('#notice-card .notice-chips button').filter({hasText:'#501'}).click();
  await wait(page, async () => !(await window.midgard.getState()).assistance.preferences.selectedCardIds.includes(501));
  assert.deepEqual(errors, []);
  console.log('Passed: quick add, lookup, duplicate, invalid ID, mute, fixed presets, threshold, inheritance, observed loot, Finance, restart, removal and responsive themes.', directory);
} catch (error) {
  if (page) await page.screenshot({path:path.join(directory,'failure.png')}).catch(() => {});
  console.error(directory, errors);
  throw error;
} finally {await app?.close();}
