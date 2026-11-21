import {_electron as electron} from 'playwright';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {wait} from './qa-wait.mjs';

// Generated archive in a unique profile. No real Replay, profile, or game file is touched.
const output=path.resolve('.qa',`kill-workspace-${Date.now()}`),profile=path.join(output,'profile');
await mkdir(profile,{recursive:true});
await build({entryPoints:['electron/expansion-store.ts'],outfile:path.join(output,'store.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24',external:['node:*'],logLevel:'error'});
const {ExpansionStore}=createRequire(import.meta.url)(path.join(output,'store.cjs'));
const database=path.join(profile,'midgard-live.sqlite'),seed=new ExpansionStore(database);
seed.financeCommand({type:'price.set',price:{itemId:501,itemName:'QA Korunan Defter',characterKey:null,npcPrice:null,marketPrice:42,buyCost:null,method:'market'}});
seed.setSetting('finance-view',{version:1,favoriteIds:[603],hiddenIds:[746],characterKey:null,tab:'all',sort:'value-desc',pageSize:50});
seed.close();
const db=new DatabaseSync(database),names=['Avcı Çağrı','Avcı İpek','Avcı Özgür'],keys=names.map((_,i)=>`qa:kill:${i}`),recordings=names.map(name=>createHash('sha256').update(name).digest('hex'));
const anchor=Date.parse('2026-11-02T12:00:00.000Z'),stamp='2026-11-02T20:00:00.000Z';
const addSession=db.prepare('INSERT INTO kill_count_sessions VALUES(?,?,?,?,?,?,?,?,?)'),addInterval=db.prepare('INSERT INTO kill_count_intervals VALUES(?,?,?,?,?)');
const addTotal=db.prepare('INSERT INTO kill_count_totals VALUES(?,?,?,?,?,?,?,?)'),addEvent=db.prepare('INSERT INTO kill_count_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
db.exec('BEGIN IMMEDIATE');
for(let c=0;c<3;c++){
  addSession.run(`qa-session-${c}`,keys[c],names[c],recordings[c],'replay-start',anchor,'stopped',stamp,'manual');
  addInterval.run(`qa-interval-${c}`,`qa-session-${c}`,`qa-source-${c}`,anchor,anchor+8*3600000);
  for(let i=0;i<10000;i++){
    const id=i===0?1313:900000+i,name=i===0?'Mobster':i===1?'QA Çığ İğne':i===9999?'QA Çok Uzun Yaratık Adı '.repeat(8):`QA Yaratık ${String(i).padStart(5,'0')}`;
    const times=i===0?[10000,250000,610000]:[i*1000+10000];
    addTotal.run(recordings[c],keys[c],id,0,times.length,times.length,anchor+times.at(-1),name);
    for(const ms of times)addEvent.run(`qa-event-${c}-${i}-${ms}`,`qa-session-${c}`,keys[c],recordings[c],id,100000+i,`qa-life-${c}-${i}-${ms}`,ms,0,stamp,'SYNTHETIC-qa',name,'{}');
  }
}
db.prepare('INSERT INTO target_hunt_intervals VALUES(?,?,?,?,?)').run('qa-target-span','qa-target-segment','qa-target-source',anchor,anchor+8*3600000);
const candidate=db.prepare('INSERT INTO target_hunt_candidates VALUES(?,?,?,?,?,?,?,?,?,?)'),observation=db.prepare('INSERT INTO target_hunt_observations VALUES(?,?,?,?,?)');
for(const [index,ms]of [10000,250000,610000].entries()){
  const id=`qa-target-${index}`;candidate.run(id,1313,'Mobster','SYNTHETIC-map',30000+index,anchor+ms,ms,'replay-clock','qa-target-segment','qa-target-source');
  for(let c=0;c<3;c++)observation.run(`qa-target-source-${c}`,recordings[c],`qa-target-event-${index}`,id,ms);
}
db.exec('COMMIT');db.close();
await writeFile(path.join(profile,'live-preferences.json'),JSON.stringify({version:1,sources:[],manualBindings:[],soundPaths:{},alerts:{muted:true,selectedCardIds:[],selectedMonsterIds:[1313],cityMaps:[],volume:0,weightThreshold:65,enabled:{death:true,weight:true,card:true,city:true,level:true,monster:true}}}));
const env={...process.env,MIDGARD_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.MIDGARD_DEV_URL;
let app,page;const checks=[],errors=[],screenshots=[];
const check=(value,label)=>{assert.ok(value,label);checks.push(label);};
const state=()=>page.evaluate(()=>window.midgard.getState());
const prefs=()=>page.evaluate(()=>window.midgard.getKillView());
const panel=()=>page.locator('.kill-count-panel');
const search=()=>page.getByRole('textbox',{name:'Kill Count canavar ara',exact:true});
const monsterRows=()=>page.locator('tr[data-kill-monster]');
async function launch(){app=await electron.launch({...(process.argv[2]?{executablePath:path.resolve(process.argv[2]),args:[]}:{args:['.']}),env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));await page.waitForFunction(()=>!!window.midgard);await page.getByRole('navigation',{name:'Ana gezinme'}).getByRole('button',{name:'Kill Count',exact:true}).click();await panel().waitFor();await wait(page,async()=>(await window.midgard.getState()).expansion.killCount.monsters.length===10000);}
async function tab(label){await panel().getByRole('tab',{name:label,exact:true}).click();}
async function capture(name){await page.screenshot({path:path.join(output,name),fullPage:true});screenshots.push(name);}
try{
  const started=performance.now();await launch();const initialMs=Math.round(performance.now()-started),original=await state(),originalKills=JSON.stringify(original.expansion.killCount.totals),originalFinance=JSON.stringify(original.expansion.finance),originalFinanceView=await page.evaluate(()=>window.midgard.getFinanceView());
  await monsterRows().first().waitFor();
  check(await page.locator('.assistant-hero').count()===0&&await page.locator('.assistant-audio-strip').count()===0,'Kill Count uses the compact shell without oversized repeated banners');
  check(await monsterRows().count()<=50,'Ten thousand monster types create at most fifty live rows by default');
  check((await panel().innerText()).includes('Gözlenen ölüm'),'The main count explicitly describes observations rather than claiming personal kills');
  const recordPage=await page.evaluate(()=>window.midgard.getKillRecords({limit:25}));check(recordPage.items.length===3&&recordPage.items.every(record=>record.durationMs===28800000),'Archive exposes three records with eight-hour Replay spans');
  const eventPage=await page.evaluate(()=>window.midgard.getKillEvents({limit:25}));check(eventPage.items.length===25&&!!eventPage.nextCursor,'Archive events are paginated independently of stored history size');
  const nextPage=await page.evaluate(cursor=>window.midgard.getKillEvents({limit:25,after:cursor}),eventPage.nextCursor);check(nextPage.items.every(event=>!eventPage.items.some(first=>first.id===event.id)),'Cursor paging does not repeat events tied across Replay records');
  const rhythm=await page.evaluate(()=>window.midgard.getKillRhythm({monsterId:1313,limit:25}));check(rhythm.items.length===3&&rhythm.items[0].intervalMs===360000&&rhythm.items[1].intervalMs===240000&&rhythm.items[2].intervalMs===null,'Rhythm preserves the six-minute and four-minute valid intervals and unknown first interval');
  const invalid=await page.evaluate(async()=>{try{await window.midgard.getKillEvents({limit:10000});return false;}catch{return true;}});check(invalid,'The IPC history endpoint rejects an oversized request');
  const searchStart=performance.now();await search().fill('Mobster');await page.locator('tr[data-kill-monster="1313"]').waitFor();const searchMs=Math.round(performance.now()-searchStart);check(await monsterRows().count()===1,'Search reduces ten thousand types to the requested monster');
  // The remaining native interactions use the final component accessibility contract below.
  await page.locator('tr[data-kill-monster="1313"]').getByRole('button',{name:'Mobster ayrıntılarını aç',exact:true}).click();
  await page.locator('.kill-detail').waitFor();
  check((await page.locator('.kill-detail').innerText()).includes('Son gözlemler'),'Selected monster opens a real history detail panel');
  await page.locator('tr[data-kill-monster="1313"]').getByRole('button',{name:'Mobster favorilere ekle',exact:true}).click();await wait(page,async()=>(await window.midgard.getKillView()).favoriteIds.includes(1313));
  check(JSON.stringify((await state()).expansion.killCount.totals)===originalKills,'Favorite and search change no persisted kill totals');
  await search().fill('cig igne');await page.locator('tr[data-kill-monster="900001"]').waitFor();check(true,'Turkish accent-insensitive search finds the stored monster name');
  await search().fill('');await page.getByRole('combobox',{name:'Kill Count karakteri',exact:true}).selectOption(keys[0]);
  check(JSON.stringify((await state()).expansion.killCount.totals)===originalKills,'Character scope leaves aggregate accounting unchanged');
  await page.getByRole('combobox',{name:'Kill Count karakteri',exact:true}).selectOption('all');
  await tab('Geçmiş');
  check((await panel().innerText()).includes('Replay'),'History is an actual archive view with recorded scope');
  await page.getByRole('combobox',{name:'Kill Count kaydı',exact:true}).selectOption(recordings[0]);
  await page.locator('tr[data-kill-event]').first().waitFor();
  check(await page.locator('tr[data-kill-event]').count()<=50,'A selected Replay record still renders only one bounded history page');
  const historyRows=await page.locator('tr[data-kill-event]').allTextContents();
  check(historyRows.every(text=>text.includes(names[0])&&!text.includes(names[1])&&!text.includes(names[2])),'The history table shows only the selected recording character');
  await page.getByRole('button',{name:'Siyah tema',exact:true}).click();await capture('kill-history-dark-1480.png');
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'The selected-record history table fits the desktop width');
  check(await page.locator('.kill-history-scroll').evaluate(node=>{const bounds=node.getBoundingClientRect();return [...node.querySelectorAll('tr[data-kill-event]')].filter(row=>{const r=row.getBoundingClientRect();return r.top>=bounds.top&&r.bottom<=bounds.bottom;}).length>=3;}),'History retains a readable observation area in the standard desktop window');
  check(await page.locator('.kill-history-notice').evaluate(node=>node.getBoundingClientRect().bottom<=node.closest('.kill-list').getBoundingClientRect().bottom+1),'The history scope explanation is fully visible inside its panel');
  await page.getByRole('button',{name:'Sonraki geçmiş sayfası',exact:true}).click();
  check(await page.locator('tr[data-kill-event]').count()<=50,'History pagination remains bounded on the next page');
  await tab('Canlı');await search().fill('Mobster');await page.locator('tr[data-kill-monster="1313"]').getByRole('button',{name:'Mobster ayrıntılarını aç',exact:true}).click();
  await page.locator('.kill-detail').getByRole('button',{name:'Tüm geçmişi aç',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('tr[data-kill-event]').length===9);
  check((await prefs()).recordingKey===null,'Open full monster history clears a previously selected single recording');
  check((await page.locator('tr[data-kill-event]').allTextContents()).every(text=>text.includes('Mobster')),'Full monster history applies the visible selected-monster filter');
  await tab('Canlı');await search().fill('');
  await page.locator('.kill-detail').evaluate(node=>{node.scrollTop=node.scrollHeight;});
  check(await page.locator('.kill-close').evaluate(node=>{const close=node.getBoundingClientRect(),panel=node.closest('.kill-detail').getBoundingClientRect();return close.top>=panel.top&&close.bottom<=panel.bottom;}),'The monster name and close control remain reachable while the detail pane is scrolled');
  await page.locator('.kill-detail').evaluate(node=>{node.scrollTop=0;});
  await page.getByRole('button',{name:'Siyah tema',exact:true}).click();await capture('kill-dark-1480.png');await page.getByRole('button',{name:'Açık tema',exact:true}).click();await capture('kill-light-1480.png');
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'The wide Kill Count layout has no horizontal overflow');
  check(await page.locator('.kill-detail').evaluate(node=>node.getBoundingClientRect().bottom<=innerHeight+2),'The desktop detail panel stays inside the remaining viewport');
  await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows()[0].setSize(1100,820));await page.waitForTimeout(120);await capture('kill-light-1100.png');await page.getByRole('button',{name:'Siyah tema',exact:true}).click();await capture('kill-dark-1100.png');
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'The 1100px detail drawer fits without horizontal overflow');
  const saved=await prefs();check(JSON.stringify((await state()).expansion.finance)===originalFinance&&JSON.stringify(await page.evaluate(()=>window.midgard.getFinanceView()))===JSON.stringify(originalFinanceView),'Finance ledger and Finance view preferences remain unchanged');
  await app.close();app=null;await launch();check(JSON.stringify(await prefs())===JSON.stringify(saved),'Kill Count preferences survive a clean restart');check(JSON.stringify((await state()).expansion.killCount.totals)===originalKills,'Restart preserves death observations without counting archive history again');
  check(errors.length===0,'No renderer errors');
  const report={output,executable:process.argv[2]?path.resolve(process.argv[2]):'source electron .',initialItemTypes:10000,storedEvents:30006,initialMs,searchMs,passed:checks.length,checks,rendererErrors:errors,screenshots,scope:'Synthetic materialized archive only; no actual Replay or user profile. Search includes automation overhead.'};await writeFile(path.join(output,'kill-workspace-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await writeFile(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:String(error),stack:error.stack},null,2));try{await capture('failure.png');}catch{}throw error;}finally{await app?.close();}
