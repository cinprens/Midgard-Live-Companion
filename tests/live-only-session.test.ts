import { afterEach,describe,expect,it } from 'vitest';
import { mkdir,mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDefaultAlertPreferences,validateAlertPreferences } from '../src/domain/notifications';
import { LiveOnlySession,LivePreferenceStore,MAX_AUDIO_BYTES,readMemorySound } from '../electron/live-only-session';
import type { LiveRuntimeState } from '../src/shared/types';
import { LiveController } from '../electron/live/controller';
import { parseReplay } from '../src/parser';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const action of cleanup.splice(0).reverse())await action();});
async function directory(){await mkdir('.qa',{recursive:true});const dir=await mkdtemp(path.resolve('.qa/live-only-test-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));return dir;}
const store=(file:string)=>new LivePreferenceStore(file,createDefaultAlertPreferences,validateAlertPreferences);
const runtime=(sourcePath:string):LiveRuntimeState=>({streams:[{id:'stream-a',filename:'selected.rrf',sourcePath,status:'following',revision:1,readPosition:100,fileSize:100,bytesReadTotal:100,lastActivityAt:'2026-11-01T00:00:00Z',lastSuccessfulReadAt:null,diagnostics:[],packetCount:4,eventCount:4,summary:null,compatibility:'skadi-unverified'}],limits:{maxWorkers:1,memoryBudgetBytes:1000000,perFileBytes:100000,pollIntervalMs:1500,settleMs:3000},activeWorkers:0,queuedCount:0,bufferedBytes:100,discovery:{enabled:false,folder:null,blockedReason:null},compatibility:'skadi-unverified',mode:'experimental-snapshots'});
describe('LIVE-only preference persistence',()=>{
  it('loads old alert preferences read-only and preserves old/custom monster sound references on save',async()=>{
    const dir=await directory(),file=path.join(dir,'live-preferences.json'),cardSound=path.join(dir,'old-card.wav'),monsterSound=path.join(dir,'monster.wav');
    const legacy={version:1,alerts:{enabled:{death:false,weight:true,card:true,city:false,level:true},weightThreshold:67,selectedCardIds:[4317],cityMaps:['prontera'],volume:31,muted:false},sources:[],manualBindings:[],soundPaths:{card:cardSound}};
    const content=JSON.stringify(legacy);await writeFile(file,content);const loaded=await store(file).load();
    expect(loaded.problem).toBeNull();expect(loaded.preferences.alerts).toMatchObject({selectedMonsterIds:[1313],enabled:{monster:true,death:false},volume:31});expect(await readFile(file,'utf8')).toBe(content);
    loaded.preferences.soundPaths.monster=monsterSound;await store(file).save(loaded.preferences);const reloaded=await store(file).load();
    expect(reloaded.preferences.soundPaths).toEqual({card:cardSound,monster:monsterSound});expect(reloaded.preferences.alerts.selectedCardIds).toEqual([4317]);
  });
  it('creates no file just by loading an unused fresh preference store',async()=>{
    const dir=await directory();const loaded=await store(path.join(dir,'live-preferences.json')).load();expect(loaded.problem).toBeNull();expect(loaded.preferences.sources).toEqual([]);expect(await readdir(dir)).toEqual([]);
  });
  it('loads legacy file choices without inventing or saving a Replay folder',async()=>{
    const dir=await directory(),file=path.join(dir,'live-preferences.json'),preferences=store(file).fresh();
    delete preferences.replayFolder;preferences.sources=[path.join(dir,'old.rrf')];
    const content=JSON.stringify(preferences);await writeFile(file,content);
    const loaded=await store(file).load();expect(loaded.problem).toBeNull();expect(loaded.preferences).not.toHaveProperty('replayFolder');
    expect(loaded.preferences.sources).toEqual(preferences.sources);expect(await readFile(file,'utf8')).toBe(content);
  });
  it('persists one selected Replay folder without growing a discovered-file preference list',async()=>{
    const dir=await directory(),file=path.join(dir,'live-preferences.json'),session=new LiveOnlySession(store(file).fresh());
    session.setSources([path.join(dir,'old.rrf')]);session.preferences.alerts.volume=31;
    session.setReplayFolder(path.join(dir,'Replay'));session.setSources(Array.from({length:1000},(_,index)=>path.join(dir,'Replay',`${index}.rrf`)));
    await store(file).save(session.preferences);const loaded=await store(file).load();
    expect(loaded.problem).toBeNull();expect(loaded.preferences).toMatchObject({version:1,replayFolder:path.join(dir,'Replay'),sources:[],alerts:{volume:31}});
    expect(JSON.parse(await readFile(file,'utf8')).sources).toEqual([]);
    session.setReplayFolder(null);session.setSources([path.join(dir,'manual.rrf')]);await store(file).save(session.preferences);
    expect((await store(file).load()).preferences).toMatchObject({replayFolder:null,sources:[path.join(dir,'manual.rrf')]});
  });
  it.each(['Replay','',123,'C:\\Replay\nfolder','C:\\Replay\u0000folder','C:\\Replay\u007ffolder'])('rejects an invalid Replay folder without changing saved preferences (%j)',async invalid=>{
    const dir=await directory(),file=path.join(dir,'live-preferences.json'),session=new LiveOnlySession(store(file).fresh());
    session.setReplayFolder(path.join(dir,'Replay'));await store(file).save(session.preferences);const before=await readFile(file,'utf8');
    expect(()=>session.setReplayFolder(invalid as string)).toThrow('Replay klasörü');expect(session.preferences.replayFolder).toBe(path.join(dir,'Replay'));
    await expect(store(file).save({...session.preferences,replayFolder:invalid as string})).rejects.toThrow('Replay klasörü');
    expect(await readFile(file,'utf8')).toBe(before);
  });
  it('round-trips independent game sound references without losing existing custom sound paths',async()=>{
    const dir=await directory(),file=path.join(dir,'live-preferences.json'),preferences=store(file).fresh();
    preferences.soundPaths={card:path.join(dir,'old-card.wav'),monster:path.join(dir,'old-custom-monster.ogg')};
    preferences.gameLevelSound={archivePath:path.join(dir,'installed.grf'),entry:'data\\wav\\levelup.wav'};
    preferences.gameMobsterSound={archivePath:path.join(dir,'installed.grf'),entry:'data\\wav\\mobster_die.wav'};
    preferences.alerts.volume=29;preferences.alerts.selectedCardIds=[4317];
    await store(file).save(preferences);const loaded=await store(file).load();
    expect(loaded.problem).toBeNull();
    expect(loaded.preferences.gameLevelSound).toEqual(preferences.gameLevelSound);
    expect(loaded.preferences.gameMobsterSound).toEqual(preferences.gameMobsterSound);
    expect(loaded.preferences.soundPaths).toEqual(preferences.soundPaths);
    loaded.preferences.alerts.weightThreshold=72;await store(file).save(loaded.preferences);
    const saved=JSON.parse(await readFile(file,'utf8'));
    expect(saved.gameLevelSound).toEqual(preferences.gameLevelSound);
    expect(saved.gameMobsterSound).toEqual(preferences.gameMobsterSound);
    expect(saved.soundPaths).toEqual(preferences.soundPaths);
    expect(saved.alerts).toMatchObject({volume:29,weightThreshold:72,selectedCardIds:[4317]});
    expect(await readdir(dir)).toEqual(['live-preferences.json']);
  });
  it('keeps older preferences without Mobster game audio compatible and does not invent a saved reference',async()=>{
    const dir=await directory(),file=path.join(dir,'live-preferences.json'),preferences=store(file).fresh();
    preferences.soundPaths.monster=path.join(dir,'existing.wav');
    preferences.gameLevelSound={archivePath:path.join(dir,'installed.grf'),entry:'data\\wav\\effect\\st_job_level_up.wav'};
    const legacy=JSON.stringify(preferences);await writeFile(file,legacy);
    const loaded=await store(file).load();expect(loaded.problem).toBeNull();expect(await readFile(file,'utf8')).toBe(legacy);
    expect(loaded.preferences).not.toHaveProperty('gameMobsterSound');
    await store(file).save(loaded.preferences);const saved=JSON.parse(await readFile(file,'utf8'));
    expect(saved).not.toHaveProperty('gameMobsterSound');expect(saved.gameLevelSound).toEqual(preferences.gameLevelSound);
    expect(saved.soundPaths).toEqual(preferences.soundPaths);
  });
  it.each([
    {label:'a different archive entry',archivePath:'installed.grf',entry:'data\\wav\\mobster_attack.wav',absolute:true},
    {label:'a non-GRF archive',archivePath:'installed.wav',entry:'data\\wav\\mobster_die.wav',absolute:true},
    {label:'a relative archive path',archivePath:'installed.grf',entry:'data\\wav\\mobster_die.wav',absolute:false},
  ])('rejects $label while preserving the previous valid preference file',async({archivePath,entry,absolute})=>{
    const dir=await directory(),file=path.join(dir,'live-preferences.json'),preferences=store(file).fresh();
    preferences.soundPaths.card=path.join(dir,'old-card.wav');await store(file).save(preferences);
    const before=await readFile(file,'utf8');
    preferences.gameMobsterSound={archivePath:absolute?path.join(dir,archivePath):archivePath,entry};
    await expect(store(file).save(preferences)).rejects.toThrow('Mobster');expect(await readFile(file,'utf8')).toBe(before);
    const malformed=JSON.stringify(preferences);await writeFile(file,malformed);
    const loader=store(file),loaded=await loader.load();expect(loaded.problem).toContain('üzerine yazılmadı');
    expect(loaded.preferences).not.toHaveProperty('gameMobsterSound');
    await expect(loader.save(loaded.preferences)).rejects.toThrow('üzerine yazılmadı');expect(await readFile(file,'utf8')).toBe(malformed);
  });
  it('persists only user preferences and never serializes attached gameplay data',async()=>{
    const dir=await directory(),file=path.join(dir,'live-preferences.json'),preferences=store(file).fresh();
    preferences.sources=[path.join(dir,'selected.rrf')];preferences.alerts.weightThreshold=65;
    Object.assign(preferences,{records:[{damage:123,events:['private-event']}],notifications:[{message:'private-alert'}],history:['private-history'],summary:{exp:77}});
    await store(file).save(preferences);
    const saved=JSON.parse(await readFile(file,'utf8'));
    expect(Object.keys(saved).sort()).toEqual(['alerts','manualBindings','replayFolder','soundPaths','sources','version']);
    expect(JSON.stringify(saved)).not.toMatch(/private-event|private-alert|private-history|"damage"|"exp"|"summary"/);
    expect((await store(file).load()).preferences.sources).toEqual(preferences.sources);
    expect(await readdir(dir)).toEqual(['live-preferences.json']);
  });
  it('keeps corrupt preference files unchanged and applies temporary defaults',async()=>{
    const dir=await directory(),file=path.join(dir,'live-preferences.json');await writeFile(file,'{incomplete');
    const preferences=store(file),loaded=await preferences.load();expect(loaded.problem).toContain('üzerine yazılmadı');
    await expect(preferences.save(loaded.preferences)).rejects.toThrow('üzerine yazılmadı');expect(await readFile(file,'utf8')).toBe('{incomplete');
  });
  it('does not read or alter a legacy SQLite archive beside the new preferences',async()=>{
    const dir=await directory(),legacy=path.join(dir,'midgard-replay.sqlite');await writeFile(legacy,'legacy-archive-sentinel');
    const preferences=store(path.join(dir,'live-preferences.json'));await preferences.load();await preferences.save(preferences.fresh());
    expect(await readFile(legacy,'utf8')).toBe('legacy-archive-sentinel');expect((await readdir(dir)).sort()).toEqual(['live-preferences.json','midgard-replay.sqlite']);
  });
  it('stores manual names as preferences without manufacturing recorded actor identity',async()=>{
    const dir=await directory(),preferences=store(path.join(dir,'live-preferences.json')).fresh(),source=path.join(dir,'selected.rrf'),session=new LiveOnlySession(preferences);
    session.assign(source,{name:'Işık Çığ Özgür Şövalye'});session.setSources([source]);
    const identity=session.applyIdentities(runtime(source)).streams[0].character;
    expect(identity).toMatchObject({name:'Işık Çığ Özgür Şövalye',source:'manual',playerId:null});
    expect(session.preferences.manualBindings).toHaveLength(1);expect(session.preferences).not.toHaveProperty('events');
    session.assign(source,null);expect(session.applyIdentities(runtime(source)).streams[0].character?.source).toBe('unassigned');session.clear();
  });
});
describe('user-selected audio stays in memory',()=>{
  const wav=()=>{const bytes=Buffer.alloc(46);bytes.write('RIFF',0);bytes.writeUInt32LE(38,4);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(16000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(2,40);return bytes;};
  it('returns an in-memory sound without copying a selected audio file',async()=>{
    const dir=await directory(),file=path.join(dir,'selected.wav');const bytes=wav();await writeFile(file,bytes);
    const sound=await readMemorySound(file);expect(sound.name).toBe('selected.wav');expect(sound.dataUrl).toBe(`data:audio/wav;base64,${bytes.toString('base64')}`);expect(await readdir(dir)).toEqual(['selected.wav']);expect(await readFile(file)).toEqual(bytes);
  });
  it('rejects renamed non-audio content and oversized source files',async()=>{
    const dir=await directory(),fake=path.join(dir,'not-audio.wav'),large=path.join(dir,'large.wav');await writeFile(fake,'this is not a wave');await writeFile(large,Buffer.alloc(MAX_AUDIO_BYTES+1));
    await expect(readMemorySound(fake)).rejects.toThrow('biçimi');await expect(readMemorySound(large)).rejects.toThrow('10 MB');expect((await readdir(dir)).sort()).toEqual(['large.wav','not-audio.wav']);
  });
});
it('delivers coherent snapshots without an archive callback and latches a recording reset across an incomplete file',async()=>{
  const dir=await directory(),source=path.join(dir,'source.rrf'),original=await readFile(path.resolve('tests/fixtures/latam-mergulho-test.rrf'));await writeFile(source,original);
  const resets:boolean[]=[];const live=new LiveController({autoPoll:false,parser:async(bytes,name)=>parseReplay(bytes,name),limits:{memoryBudgetBytes:3*1024*1024,maxWorkers:1,settleMs:0},onSnapshot:(_parsed,meta)=>{resets.push(Boolean(meta.recordingReset));}});cleanup.push(()=>live.close());
  await live.addFiles([source]);await live.waitForIdle();expect(resets).toEqual([false]);
  const headerPatch=Buffer.from(original);headerPatch[60]^=1;await writeFile(source,headerPatch);await live.refresh();await live.waitForIdle();expect(resets).toEqual([false,false]);
  await writeFile(source,original.subarray(0,64));await live.refresh();await live.waitForIdle();expect(resets).toHaveLength(2);
  await writeFile(source,original);await live.refresh();await live.waitForIdle();expect(resets).toEqual([false,false,true]);
  expect((await readdir(dir)).sort()).toEqual(['source.rrf']);
});

it('keeps the last coherent summary visible while a growing recording rewrites its header and is parsed again',async()=>{
  const dir=await directory(),source=path.join(dir,'growing.rrf'),original=await readFile(path.resolve('tests/fixtures/latam-mergulho-test.rrf'));await writeFile(source,original);
  let calls=0,entered!:()=>void,release!:()=>void;
  const parsing=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;}),resets:boolean[]=[];
  const live=new LiveController({autoPoll:false,parser:async(bytes,name)=>{if(++calls===2){entered();await gate;}return parseReplay(bytes,name);},limits:{memoryBudgetBytes:3*1024*1024,maxWorkers:1,settleMs:0},onSnapshot:(_parsed,meta)=>{resets.push(Boolean(meta.recordingReset));}});
  cleanup.push(async()=>{release();await live.close();});
  await live.addFiles([source]);await live.waitForIdle();const before=live.snapshot().streams[0];expect(before.summary?.characterName).toBe('Preá');
  const changed=Buffer.concat([original,Buffer.from([0,0,0])]);changed[60]^=1;await writeFile(source,changed);await live.refresh();await parsing;
  try{
    const updating=live.snapshot().streams[0];expect(updating.status).toBe('analyzing');expect(updating.fileSize).toBe(changed.length);
    expect(updating.summary).toEqual(before.summary);expect(updating.contentHash).toBe(before.contentHash);expect(updating.packetCount).toBe(before.packetCount);expect(updating.eventCount).toBe(before.eventCount);
  }finally{release();}
  await live.waitForIdle();const after=live.snapshot().streams[0];expect(after.summary).not.toBeNull();expect(after.contentHash).not.toBe(before.contentHash);expect(resets).toEqual([false,false]);
});
