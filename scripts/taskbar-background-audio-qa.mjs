import assert from 'node:assert/strict';
import {mkdtempDisposable, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {_electron as electron} from 'playwright';
import {seedLiveAdventure} from './live-adventure-fixtures.mjs';
import {status, verifiedItemReceipt} from './assistance-fixtures.mjs';

await using output = await mkdtempDisposable(path.join(tmpdir(), 'midgard-audio-'));
const fixture = await seedLiveAdventure(output.path, {openStream: true});
const preferencesPath = path.join(fixture.profile, 'live-preferences.json');
const saved = JSON.parse(await readFile(preferencesPath, 'utf8'));
Object.assign(saved.alerts, {muted: false, volume: 80, selectedCardIds: [972]});
saved.alerts.enabled['glass-bead'] = true;
saved.soundPaths.card = path.resolve('build/audio/loot-chime.wav');
await writeFile(preferencesPath, JSON.stringify(saved));

const env = {...process.env, MIDGARD_USER_DATA: fixture.profile};
delete env.ELECTRON_RUN_AS_NODE;
delete env.MIDGARD_DEV_URL;
const args = ['--mute-audio', '--replace-live-sources', ...fixture.files.map(file => '--live-file=' + file)];
const executable = process.argv[2];
const app = await electron.launch(executable ? {executablePath: path.resolve(executable), args, env} : {args: ['.', ...args], env});

// Do not grant a browser user gesture when observing or exercising cold-start audio.
const run = fn => app.evaluate(({BrowserWindow}, script) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script, false), '(' + fn.toString() + ')()');
async function until(label, predicate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await run(predicate)) return;
    await delay(50);
  }
  throw new Error(label + ' timed out');
}

async function receive(id, slot, weight, at) {
  await fixture.append(0, verifiedItemReceipt(id, 1, slot, weight, weight + 10), at);
  // A later packet closes the replay reader's ownership evidence window.
  await fixture.append(0, [status(5, 4935)], at + 1000);
}

async function checkSignal(label, id, count, expected) {
  const deadline = Date.now() + 15000;
  let sample;
  while (Date.now() < deadline) {
    sample = await run(() => window.audioProbe.sample());
    if (sample.receipts.filter(value => value === id).length === count && sample.peak > 0.001) break;
    await delay(35);
  }
  assert.equal(sample.receipts.filter(value => value === id).length, count, label);
  assert.ok(sample.peak > 0.001, label + ' must produce a nonzero waveform');
  assert.equal(sample[expected] > 0, true, label + ' must use its assigned sound');
  assert.equal(sample[expected === 'tones' ? 'buffers' : 'tones'], 0, label + ' must use just one sound path');
  console.log(label, JSON.stringify(sample));
}

try {
  await app.firstWindow();
  await until('live replay baseline', async () => {
    if (!document.querySelector('.taskbar-launch')) return false;
    const state = await window.midgard?.getState();
    return state?.live?.streams.length === 3 && state.live.streams.every(stream => stream.summary && ['settled', 'following'].includes(stream.status));
  });
  await run(() => {
    const probe = window.audioProbe = {receipts: [], buffers: 0, tones: 0, analyser: null, context: null};
    window.midgard.onNotification(event => { if (event.itemId) probe.receipts.push(event.itemId); });
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (target, ...rest) {
      const result = connect.call(this, target, ...rest);
      if (target === this.context.destination) {
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 32768;
        connect.call(this, analyser);
        probe.analyser = analyser;
        probe.context = this.context;
      }
      return result;
    };
    for (const [type, counter] of [[AudioBufferSourceNode, 'buffers'], [OscillatorNode, 'tones']]) {
      const start = type.prototype.start;
      type.prototype.start = function (...times) { probe[counter]++; return start.apply(this, times); };
    }
    probe.sample = () => {
      const data = new Float32Array(probe.analyser?.fftSize ?? 0);
      probe.analyser?.getFloatTimeDomainData(data);
      let peak = 0;
      for (const value of data) peak = Math.max(peak, Math.abs(value));
      return {peak, receipts: probe.receipts, buffers: probe.buffers, tones: probe.tones};
    };
    probe.clear = () => { probe.analyser = null; probe.buffers = 0; probe.tones = 0; };
  });
  assert.equal(await run(() => navigator.userActivation.hasBeenActive), false);
  await receive(972, 32, 12900, 710000);
  await checkSignal('Cold start, selected item and custom WAV', 972, 1, 'buffers');
  assert.equal(await run(() => navigator.userActivation.hasBeenActive), false);

  await run(() => document.querySelector('.taskbar-launch').click());
  await until('taskbar layout', () => !!document.querySelector('.taskbar-party-row'));
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].hide());
  const windowState = await app.evaluate(({BrowserWindow}) => {
    const win = BrowserWindow.getAllWindows()[0];
    return {visible: win.isVisible(), focused: win.isFocused()};
  });
  assert.deepEqual(windowState, {visible: false, focused: false});
  console.log('Taskbar background conditions', windowState, await run(() => ({hidden: document.hidden, focus: document.hasFocus()})));
  await run(async () => { window.audioProbe.clear(); await window.audioProbe.context.suspend(); });
  assert.equal(await run(() => window.audioProbe.context.state), 'suspended');
  await receive(746, 33, 12910, 720000);
  await checkSignal('Hidden taskbar, suspended output, legacy Glass Bead target uses the general item WAV', 746, 1, 'buffers');
  assert.equal(await run(() => window.audioProbe.context.state), 'running');

  await run(() => window.audioProbe.clear());
  await receive(972, 32, 12920, 730000);
  await checkSignal('Hidden taskbar, second selected item and custom WAV', 972, 2, 'buffers');
  await run(async () => { await window.midgard.setAlertPreferences({muted: true}); window.audioProbe.clear(); });
  await receive(972, 32, 12930, 740000);
  await until('muted receipt', () => window.audioProbe.receipts.filter(id => id === 972).length === 3);
  const muted = await run(() => window.audioProbe.sample());
  assert.deepEqual([muted.buffers, muted.tones, muted.peak], [0, 0, 0]);
  console.log('Muted taskbar delivered the visual receipt without audio.');
} finally {
  await app.close();
}
