import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdtempDisposable, mkdir, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const projectRequire = createRequire(import.meta.url);
const { _electron: electron } = projectRequire('playwright');
const archive = path.resolve(process.argv[2] ?? path.join(repoRoot, 'release', 'win-unpacked', 'resources', 'app.asar'));
assert.ok((await stat(archive)).isFile(), 'Specify the unpacked Windows application archive');
const main = path.join(archive, 'dist-electron', 'main.cjs');

await using temporary = await mkdtempDisposable(path.join(tmpdir(), 'midgard-packaged-public-names-'));
const paths = Object.fromEntries(['desktop','appData','userData','sessionData','logs','drive','home','wrapper','crashDumps']
  .map(key => [key, path.join(temporary.path, key)]));
await Promise.all(Object.values(paths).map(folder => mkdir(folder)));
const localNames = path.join(paths.wrapper, 'game-names.local.json');
await assert.rejects(() => readFile(localNames), {code:'ENOENT'});
assert.deepEqual(await readdir(paths.userData), []);
assert.deepEqual(await readdir(paths.desktop), []);
assert.deepEqual(await readdir(paths.drive), []);
await writeFile(path.join(paths.wrapper, 'package.json'), JSON.stringify({name:'midgard-clean-install-probe', main:'start.cjs'}));
// These paths are configured before importing the application's untouched packaged entry.
// Windows known folders need explicit overrides even when USERPROFILE has been changed.
await writeFile(path.join(paths.wrapper, 'start.cjs'), [
  "const {app} = require('electron');",
  "const paths = JSON.parse(process.env.MIDGARD_QA_PATHS);",
  "for (const key of ['home','desktop','appData','userData','sessionData','logs','crashDumps']) app.setPath(key, paths[key]);",
  "require('node:assert/strict').equal(app.getAppPath(), paths.wrapper);",
  'require(process.env.MIDGARD_QA_PACKAGED_MAIN);',
].join('\n'));

const env = {...process.env, MIDGARD_QA_PATHS:JSON.stringify(paths), MIDGARD_QA_PACKAGED_MAIN:main,
  MIDGARD_USER_DATA:paths.userData, PORTABLE_EXECUTABLE_DIR:paths.wrapper,
  APPDATA:paths.appData, LOCALAPPDATA:paths.appData, USERPROFILE:paths.home,
  HOME:paths.home, SystemDrive:paths.drive};
delete env.ELECTRON_RUN_AS_NODE;
delete env.MIDGARD_DEV_URL;
const netLog = path.join(temporary.path, 'network.json');
const app = await electron.launch({executablePath:projectRequire('electron'),
  args:[paths.wrapper, '--mute-audio', '--log-net-log=' + netLog], env});
let report;
try {
  const resolved = await app.evaluate(({app}) => ({
    desktop:app.getPath('desktop'), userData:app.getPath('userData'), profile:app.getAppPath(),
    gameRoot:process.env.SystemDrive, portable:process.env.PORTABLE_EXECUTABLE_DIR,
    replayArgs:process.argv.filter(arg => arg.startsWith('--live-file=')),
  }));
  assert.deepEqual(resolved, {desktop:paths.desktop, userData:paths.userData, profile:paths.wrapper,
    gameRoot:paths.drive, portable:paths.wrapper, replayArgs:[]});
  const page = await app.firstWindow({timeout:60000});
  await page.getByRole('navigation', {name:'Ana gezinme'}).waitFor({timeout:60000});
  assert.equal(path.normalize(fileURLToPath(page.url())), path.join(archive, 'dist', 'index.html'));
  const result = await page.evaluate(async () => {
    const targets = await window.midgard.getAlertTargetNames();
    const state = await window.midgard.getState();
    return {targets, streams:state.live.streams.length};
  });
  assert.equal(result.streams, 0);
  const {items, rareItems, monsters} = result.targets;
  const counts = {cards:rareItems.filter(([,kind]) => kind === 'card').length,
    costumes:rareItems.filter(([,kind]) => kind === 'costume').length, monsters:monsters.length};
  assert.deepEqual(counts, {cards:324, costumes:1413, monsters:489});
  const itemNames = new Map(items), categories = new Map(rareItems), monsterNames = new Map(monsters);
  assert.equal(itemNames.get(4003), 'Pupa Card');
  assert.equal(categories.get(4003), 'card');
  assert.equal(itemNames.get(5914), 'Costume Flutter Butterfly');
  assert.equal(categories.get(5914), 'costume');
  assert.equal(monsterNames.get(1004), 'Hornet');

  await page.getByRole('button', {name:'Bildirim ayarları', exact:true}).click();
  const rare = page.getByRole('region', {name:'Kart ve kostüm sesleri'});
  await rare.getByRole('button', {name:/^Kartlar/}).click();
  await rare.getByRole('searchbox', {name:'Özel ses için kart ara'}).fill('Pupa Card');
  await rare.getByRole('button', {name:/^Pupa Card\s+#4003$/}).waitFor();
  await rare.getByRole('button', {name:/^Kostümler/}).click();
  await rare.getByRole('searchbox', {name:'Özel ses için kostüm ara'}).fill('Costume Flutter Butterfly');
  await rare.getByRole('button', {name:/^Costume Flutter Butterfly\s+#5914$/}).waitFor();
  const quick = page.getByRole('region', {name:'Hızlı bildirim ekle'});
  await quick.getByRole('button', {name:'Yaratık', exact:true}).click();
  await quick.getByRole('textbox', {name:'Yaratık adı veya kimliği'}).fill('Hornet');
  const hornet = quick.getByRole('button', {name:'Hornet bildirimi ekle', exact:true});
  await hornet.waitFor();
  assert.match(await hornet.innerText(), /#1004/);
  assert.deepEqual(await readdir(paths.desktop), []);
  assert.deepEqual(await readdir(paths.drive), []);
  // A loopback-only listener verifies both sessions block HTTP before any connection reaches the network.
  const hits = {connections:0, requests:0};
  const receiver = createServer((_request, response) => { hits.requests++; response.end('qa'); });
  receiver.on('connection', () => { hits.connections++; });
  await new Promise((resolve, reject) => {
    receiver.once('error', reject);
    receiver.listen(0, '127.0.0.1', resolve);
  });
  let blocked;
  try {
    const url = 'http://127.0.0.1:' + receiver.address().port + '/midgard-offline-probe';
    blocked = await app.evaluate(async ({BrowserWindow, session}, url) => {
      const windowSession = BrowserWindow.getAllWindows()[0].webContents.session;
      if (windowSession === session.defaultSession) throw new Error('Expected separate application and renderer sessions');
      const result = {};
      for (const [key, target] of [['defaultSession', session.defaultSession], ['windowSession', windowSession]]) {
        try {
          const reply = await target.fetch(url, {signal:AbortSignal.timeout(6000)});
          result[key] = 'HTTP ' + reply.status;
          await reply.text();
        } catch (err) { result[key] = String(err); }
      }
      return result;
    }, url);
    for (const error of Object.values(blocked)) assert.match(error, /ERR_BLOCKED_BY_CLIENT/);
    assert.deepEqual(hits, {connections:0, requests:0});
  } finally {
    await new Promise(resolve => receiver.close(resolve));
  }
  report = {archive:path.basename(archive), ...counts, replayStreams:result.streams, settingsSearch:['Pupa Card #4003','Costume Flutter Butterfly #5914','Hornet #1004'],
    probes:blocked, loopback:hits};
} finally {
  await app.close();
}
const trace = JSON.parse(await readFile(netLog, 'utf8'));
assert.ok(Array.isArray(trace.events) && trace.events.length > 0, 'Chromium network logging must be enabled from launch');
const destinations = new Set();
const outsideEvents = new Set();
const eventTypes = new Map(Object.entries(trace.constants.logEventTypes).map(([name, id]) => [id,name]));
const sourceTypes = new Map(Object.entries(trace.constants.logSourceType).map(([name, id]) => [id,name]));
for (const event of trace.events) {
  const address = event.params?.url;
  if (typeof address !== 'string' || !/^(https?|wss?):\/\//i.test(address)) continue;
  const {hostname,origin} = new URL(address);
  if (!['localhost','127.0.0.1','[::1]'].includes(hostname)) {
    destinations.add(origin);
    outsideEvents.add(origin + ' ' + sourceTypes.get(event.source.type) + ' ' + eventTypes.get(event.type));
  }
}
assert.deepEqual([...outsideEvents], [], 'External HTTP/WebSocket URL(s) in Chromium network log');
console.log(JSON.stringify({...report, chromiumNetworkEvents:trace.events.length, externalHttpWsOrigins:[...destinations]}));
