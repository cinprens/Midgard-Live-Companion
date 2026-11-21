import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtempDisposable,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {_electron as electron,chromium} from 'playwright';
import {seedLiveAdventure,adventureKeys,adventureNames} from './live-adventure-fixtures.mjs';
import {status,verifiedItemReceipt} from './assistance-fixtures.mjs';
import {wait} from './qa-wait.mjs';
import {checkGeneralScenes} from './general-scenes-check.mjs';

await using work=await mkdtempDisposable(path.join(tmpdir(),'midgard-rare-drops-'));
const portable=process.argv[2]&&path.resolve(process.argv[2]);
const output=portable?path.dirname(portable):path.resolve('.qa/rare-scenes');
await mkdir(output,{recursive:true});
const fixture=await seedLiveAdventure(work.path,{openStream:true,extraItems:[
  {id:4255,name:'Orc Lady Card',category:'card'}, {id:5915,name:"[Costume] Angel's Veil",category:'costume'},
  {id:4001,name:'Poring Card',category:'card'}, {id:15925,name:'[Costume] Splashing Hat',category:'costume'},
]});
const prefs=path.join(fixture.profile,'live-preferences.json');
const saved=JSON.parse(await readFile(prefs,'utf8'));
Object.assign(saved.alerts,{muted:false,volume:65,selectedCardIds:[4255]});
await writeFile(prefs,JSON.stringify(saved));
// Short sine tones with distinct durations let the audio graph identify exactly which choice played.
function wav(duration,hz){
  const rate=16000,count=Math.round(rate*duration),bytes=Buffer.alloc(44+count*2);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);
  bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(count*2,40);
  for(let i=0;i<count;i++)bytes.writeInt16LE(Math.round(6000*Math.sin(2*Math.PI*i*hz/rate)),44+i*2);
  return bytes;
}
const sounds=[{category:'card',file:'Genel kart.wav',duration:.22},{category:'costume',file:'Genel kostüm.wav',duration:.36},
  {category:'card',itemId:4255,file:'Orc Lady.wav',duration:.48},{category:'costume',itemId:15925,file:'Splashing Hat.wav',duration:.6}];
for(const [i,sound] of sounds.entries()){
  sound.file=path.join(work.path,sound.file);
  await writeFile(sound.file,wav(sound.duration,300+100*i));
}
saved.soundPaths.card=sounds[0].file;
saved.soundPaths.city=sounds[1].file;
await writeFile(prefs,JSON.stringify(saved));
const db=new DatabaseSync(fixture.database);
if(portable)db.prepare('INSERT OR REPLACE INTO expansion_settings VALUES(?,?)').run('rare-drop-sounds',JSON.stringify(sounds.map(({duration,...record})=>record)));
const view=JSON.parse(db.prepare("SELECT value_json FROM expansion_settings WHERE key='live-view'").get().value_json);
view.appearanceByCharacter={[adventureKeys[0]]:'masculine-1',[adventureKeys[1]]:'feminine-2',[adventureKeys[2]]:'masculine-3'};
db.prepare("UPDATE expansion_settings SET value_json=? WHERE key='live-view'").run(JSON.stringify(view));
db.close();
const env={...process.env,MIDGARD_USER_DATA:fixture.profile};
delete env.ELECTRON_RUN_AS_NODE;delete env.MIDGARD_DEV_URL;
const args=['--mute-audio','--replace-live-sources',...fixture.files.map(file=>'--live-file='+file)];
let app,browser,page,child,exit;
async function connectPortable(){
  child=spawn(portable,[...args,'--remote-debugging-port=0'],{env,windowsHide:true,stdio:'ignore'});
  exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  const limit=Date.now()+90000;
  while(!browser&&Date.now()<limit){
    try{
      const [port,route]=(await readFile(path.join(fixture.profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);
      if(/^\d+$/.test(port)&&/^\/devtools\/browser\/[\w-]+$/.test(route))browser=await chromium.connectOverCDP('ws://127.0.0.1:'+port+route,{timeout:2000});
    }catch{}
    if(!browser)await delay(200);
  }
  assert.ok(browser,'Portable startup');
  while(!page&&Date.now()<limit){
    page=browser.contexts().flatMap(c=>c.pages()).find(p=>/\/app\.asar\/dist\/index\.html/i.test(p.url()));
    if(!page)await delay(100);
  }
  assert.ok(page,'Portable renderer');
  const url=new URL(page.url());url.hash='';url.search='';
  const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
  assert.equal(await hash(path.resolve(path.dirname(fileURLToPath(url)),'..')),await hash(path.join(output,'win-unpacked/resources/app.asar')));
}
async function append(kind,index,slot,id,weight,at){
  const packets=verifiedItemReceipt(id,1,slot,weight,weight+10);
  packets[1][33]=kind==='card'?6:kind==='costume'?4:3;
  if(kind==='costume')packets[1].writeUInt32LE(0x400,29);
  await fixture.append(index,packets,at);
  await fixture.append(index,[status(5,4500)],at+900);
}
try{
  if(portable)await connectPortable();
  else{app=await electron.launch({args:['.',...args],env});page=await app.firstWindow();}
  page.setDefaultTimeout(16000);
  const errors=[];
  page.on('pageerror',err=>errors.push(err.message));
  await page.getByRole('navigation',{name:'Ana gezinme'}).waitFor({timeout:60000});
  await wait(page,async()=>{const s=await window.midgard?.getState();return s?.live?.streams.length===3&&s.live.streams.every(r=>r.summary)&&!s.live.activeWorkers&&!s.live.queuedCount;});
  await page.getByRole('button',{name:'Bildirim ayarları',exact:true}).click();
  const settings=page.getByRole('region',{name:'Kart ve kostüm sesleri'});
  await settings.getByRole('button',{name:/^Kartlar/}).click();
  await settings.getByRole('button',{name:/^Kostümler/}).click();
  if(!portable){
    for(const sound of sounds){
      await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},sound.file);
      if(sound.itemId){
        const card=sound.category==='card';
        await settings.getByRole('searchbox',{name:card?'Özel ses için kart ara':'Özel ses için kostüm ara'}).fill(card?'Orc Lady':'Splashing Hat');
        await settings.getByRole('button',{name:new RegExp('#'+sound.itemId)}).click();
      }else await settings.getByRole('button',{name:sound.category==='card'?'Genel kart sesi için ses seç':'Genel kostüm sesi için ses seç'}).click();
      await wait(page,async name=>(await window.midgard.getState()).assistance.rareDropSounds.some(s=>s.fileName===name),path.basename(sound.file));
    }
  }
  await settings.getByRole('searchbox',{name:'Özel ses için kart ara'}).fill('');
  await settings.getByRole('searchbox',{name:'Özel ses için kostüm ara'}).fill('');
  for(const s of sounds)assert.ok((await settings.innerText()).includes(path.basename(s.file)));
  await settings.getByRole('button',{name:'Orc Lady Card dene'}).waitFor();
  await settings.screenshot({path:path.join(output,'Bildirim-Sesleri.png')});
  await page.getByRole('button',{name:'Görev çubuğu modu',exact:true}).click();
  const board=page.getByRole('main',{name:'Görev çubuğu modu'});await board.waitFor();
  assert.equal(await board.locator('article.taskbar-party-row').count(),3);
  await page.evaluate(()=>{
    window.sceneLog=[];window.soundLog=[];let previous;
    const now=()=>performance.now();
    const update=()=>{
      const el=document.querySelector('.taskbar-drop-scene'),id=el?.dataset.dropId;
      if(id===previous)return;
      if(previous)window.sceneLog.at(-1).end=now();
      if(id)window.sceneLog.push({id,kind:el.dataset.category,start:now()});
      previous=id;
    };
    new MutationObserver(update).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-drop-id']});
    const start=AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start=function(...args){
      window.soundLog.push({duration:this.buffer?.duration,state:this.context.state,at:now(),peak:this.buffer?Math.max(...this.buffer.getChannelData(0).subarray(0,1024)):0});
      return start.apply(this,args);
    };
  });
  assert.equal(await page.locator('.taskbar-drop-scene').count(),0);
  await append('card',0,32,4255,12900,709000);
  const card=board.locator('.taskbar-drop-scene[data-category="card"]');await card.waitFor();
  assert.equal(await card.locator('.drop-fighter-name strong').innerText(),adventureNames[0]);
  assert.equal(await card.locator('.drop-prize-name strong').innerText(),'Orc Lady Card');
  await append('costume',1,38,5915,17400,710000);
  await delay(500);await board.screenshot({path:path.join(output,'Kart-Sahnesi.png')});
  const costume=board.locator('.taskbar-drop-scene[data-category="costume"]');await costume.waitFor();
  assert.equal(await costume.locator('.drop-fighter-name strong').innerText(),adventureNames[1]);
  assert.equal(await costume.locator('.drop-prize-name strong').innerText(),"[Costume] Angel's Veil");
  await append('card',2,39,4001,63000,711000);
  await delay(500);await board.screenshot({path:path.join(output,'Kostum-Sahnesi.png')});
  await card.waitFor();
  assert.equal(await card.locator('.drop-fighter-name strong').innerText(),adventureNames[2]);
  assert.equal(await card.locator('.drop-prize-name strong').innerText(),'Poring Card');
  await append('costume',0,41,15925,12910,713000);
  await costume.waitFor();
  assert.equal(await costume.locator('.drop-prize-name strong').innerText(),'[Costume] Splashing Hat');
  await costume.waitFor({state:'hidden'});
  await append('ordinary',2,40,999999,63010,713000);
  await delay(1200);
  const {scenes,audio}=await page.evaluate(()=>({scenes:window.sceneLog,audio:window.soundLog}));
  assert.deepEqual(scenes.map(s=>s.kind),['card','costume','card','costume']);
  for(const s of scenes)assert.ok(s.end-s.start>=4900&&s.end-s.start<5800,'scene duration '+(s.end-s.start));
  assert.deepEqual(audio.map(s=>Math.round(s.duration*100)),[48,36,22,60]);
  audio.forEach((s,i)=>{assert.ok(s.peak>.02&&s.state==='running');assert.ok(Math.abs(s.at-scenes[i].start)<1200);});
  await board.getByRole('button',{name:'Ana pencereye dön'}).click();
  await page.getByRole('button',{name:'Finans',exact:true}).click();
  await page.getByRole('group',{name:'Finans dönemi'}).getByRole('button',{name:'Tümü'}).click();
  for(const [name,id] of [['Kartlar',4255],['Kostümler',5915]]){
    await page.getByRole('tab',{name:new RegExp('^'+name)}).click();
    await page.locator('[data-farm-item-id="'+id+'"]').waitFor();
    const other=id===4255?5915:4255;assert.equal(await page.locator('[data-farm-item-id="'+other+'"]').count(),0);
  }
  const general=await checkGeneralScenes(page,fixture,append,output);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({portable:!!portable,ms:scenes.map(s=>Math.round(s.end-s.start)),played:audio.map(s=>s.duration),general,errors}));
}finally{
  if(app)await app.close();
  if(browser){
    await page?.evaluate(()=>window.close()).catch(()=>{});
    await browser.close().catch(()=>{});
    const controller=new AbortController();
    try{await Promise.race([exit,delay(15000,undefined,{signal:controller.signal})]);}finally{controller.abort();}
  }
  if(child&&child.exitCode===null)child.kill();
}
