import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempDisposable,readFile,rename,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {_electron as electron} from 'playwright';
import {syntheticWav} from './assistance-fixtures.mjs';

await using temp=await mkdtempDisposable(path.join(tmpdir(),'midgard-sound-presets-'));
const profile=temp.path;
const preferencesFile=path.join(profile,'live-preferences.json');
const chosenFile=path.join(profile,'custom-box.wav');
const custom=syntheticWav();
await writeFile(chosenFile,custom);
const expected=await readFile(new URL('../build/audio/loot-chime.wav',import.meta.url));
assert.equal(expected.toString('ascii',0,4),'RIFF');
assert.equal(expected.toString('ascii',8,12),'WAVE');
assert.equal(expected.readUInt32LE(24),44100);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const saved=()=>readFile(preferencesFile,'utf8').then(JSON.parse);
const env={...process.env,MIDGARD_USER_DATA:profile};
delete env.ELECTRON_RUN_AS_NODE;
delete env.MIDGARD_DEV_URL;
let app,page;

async function launch(){
  app=await electron.launch(process.argv[2]?{executablePath:path.resolve(process.argv[2]),args:['--mute-audio'],env}:{args:['.','--mute-audio'],env});
  page=await app.firstWindow();
  await page.getByRole('navigation',{name:'Ana gezinme'}).waitFor({timeout:60000});
  await page.getByRole('button',{name:'Bildirim ayarları',exact:true}).click();
  await page.locator('.notice-disclosure').filter({has:page.getByText('Eşya',{exact:true})}).click();
}
async function close(){
  if(app){await app.close();app=undefined;}
}
async function readPreset(){
  const sound=await page.evaluate(()=>window.midgard.getAlertSound('old-blue-box'));
  assert.ok(sound?.dataUrl?.startsWith('data:audio/wav;base64,'));
  return {name:sound.name,hash:hash(Buffer.from(sound.dataUrl.split(',')[1],'base64'))};
}
async function verifyBuiltin(){
  const preset=await readPreset();
  assert.equal(preset.name,'MIDGARD ganimet çanı');
  assert.equal(preset.hash,hash(expected));
}

try {
  await launch();
  await verifyBuiltin();
  let box=page.getByRole('group',{name:'Old Blue Box sesi'});
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},chosenFile);
  await box.getByRole('button',{name:'Ses seç',exact:true}).click();
  await box.getByText('custom-box.wav',{exact:true}).waitFor();
  assert.equal((await readPreset()).hash,hash(custom));
  await close();

  await launch();
  assert.equal((await readPreset()).hash,hash(custom));
  assert.equal((await saved()).soundPaths['old-blue-box'],chosenFile);
  await close();

  const moved=path.join(profile,'moved-box.wav');
  await rename(chosenFile,moved);
  await launch();
  await verifyBuiltin();
  assert.equal((await saved()).soundPaths['old-blue-box'],chosenFile);
  await close();
  await rename(moved,chosenFile);
  await launch();
  assert.equal((await readPreset()).hash,hash(custom));
  box=page.getByRole('group',{name:'Old Blue Box sesi'});
  await box.getByRole('button',{name:'Ganimet çanı',exact:true}).click();
  await box.getByText('MIDGARD ganimet çanı',{exact:true}).waitFor();
  await verifyBuiltin();
  assert.equal((await saved()).soundPaths['old-blue-box'],undefined);
  await close();

  await launch();
  await verifyBuiltin();
  console.log('Passed: bundled and custom WAVs, missing-file fallback, preserved settings, preset restore and restart.');
} finally { await close(); }
