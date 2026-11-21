import {_electron as electron} from 'playwright';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {wait} from './qa-wait.mjs';

// A new generated profile is the only profile this native QA opens or changes.
const output=path.resolve('.qa',`kill-daily-${Date.now()}`),profile=path.join(output,'profile');
await mkdir(profile,{recursive:true});
await build({entryPoints:['electron/expansion-store.ts'],outfile:path.join(output,'store.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24',external:['node:*'],logLevel:'error'});
const {ExpansionStore}=createRequire(import.meta.url)(path.join(output,'store.cjs'));
const database=path.join(profile,'midgard-live.sqlite'),seed=new ExpansionStore(database);
seed.financeCommand({type:'price.set',price:{itemId:501,itemName:'QA Korunan Günlük',characterKey:null,npcPrice:null,marketPrice:42,buyCost:null,method:'market'}});
seed.setSetting('finance-view',{version:1,favoriteIds:[603],hiddenIds:[746],characterKey:null,tab:'all',sort:'value-desc',pageSize:50});
seed.close();
const db=new DatabaseSync(database),names=['Avcı Çağrı','Avcı İpek'],keys=['qa:daily:0','qa:daily:1'];
const anchor=Date.parse('2026-11-04T20:59:00.000Z'),stamp='2026-11-05T12:00:00.000Z';
const monsters=new Map([[1317,'Seal'],[1313,'Mobster'],[2829,'Swift Seal'],[1391,'Galapago']]);
const addSession=db.prepare('INSERT INTO kill_count_sessions VALUES(?,?,?,?,?,?,?,?,?)'),addInterval=db.prepare('INSERT INTO kill_count_intervals VALUES(?,?,?,?,?)');
const addTotal=db.prepare('INSERT INTO kill_count_totals VALUES(?,?,?,?,?,?,?,?)'),addEvent=db.prepare('INSERT INTO kill_count_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
const sessions=[
  {id:'qa-daily-a',character:0,basis:'replay-start',times:[[30000,1317],[59999,1313],[60000,1317],[61000,1317],[62000,1313],[63000,2829],[64000,1391]]},
  {id:'qa-daily-b',character:1,basis:'replay-start',times:[[30000,1317],[60000,1317],[70000,1313]]},
  {id:'qa-daily-undated',character:0,basis:'observation-anchor',times:[[1900,1313],[4000,1313]]},
];
db.exec('BEGIN IMMEDIATE');
for(const session of sessions){
  const recording=createHash('sha256').update(session.id).digest('hex'),owner=keys[session.character];
  addSession.run(session.id,owner,names[session.character],recording,session.basis,anchor,'stopped',stamp,'manual');
  addInterval.run(`${session.id}-interval`,session.id,`${session.id}-source`,anchor,anchor+121*60000);
  // Same-clock source overlap must not multiply the daily tracking duration.
  if(session.id==='qa-daily-a')addInterval.run(`${session.id}-overlap`,session.id,`${session.id}-other-source`,anchor+30000,anchor+120*60000);
  const totals=new Map();
  for(const [index,[ms,id]] of session.times.entries()){
    const name=monsters.get(id),group=totals.get(id)??{count:0,last:0};group.count++;group.last=Math.max(group.last,ms);totals.set(id,group);
    addEvent.run(`${session.id}-event-${index}`,session.id,owner,recording,id,500000+index,`${session.id}-life-${index}`,ms,0,stamp,'SYNTHETIC-daily',name,'{}');
  }
  for(const [id,total]of totals)addTotal.run(recording,owner,id,0,total.count,total.count,anchor+total.last,monsters.get(id));
}
db.exec('COMMIT');db.close();
await writeFile(path.join(profile,'live-preferences.json'),JSON.stringify({version:1,sources:[],manualBindings:[],soundPaths:{},alerts:{muted:true,selectedCardIds:[],selectedMonsterIds:[],cityMaps:[],volume:0,weightThreshold:65,enabled:{death:true,weight:true,card:true,city:true,level:true,monster:true}}}));
const env={...process.env,MIDGARD_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.MIDGARD_DEV_URL;
let app,page;const checks=[],errors=[],screenshots=[];
const check=(value,label)=>{assert.ok(value,label);checks.push(label);};
const state=()=>page.evaluate(()=>window.midgard.getState());
const prefs=()=>page.evaluate(()=>window.midgard.getKillView());
const panel=()=>page.locator('.kill-count-panel');
const rows=()=>page.locator('tr[data-kill-monster]');
const dateInput=()=>page.getByLabel('Kill Count günü',{exact:true});
const search=()=>page.getByRole('textbox',{name:'Kill Count canavar ara',exact:true});
const rowCount=async(id)=>Number((await page.locator(`tr[data-kill-monster="${id}"] .kill-count-cell strong`).innerText()).replaceAll('.',''));
const apiDaily=(date,characterKey=null)=>page.evaluate(input=>window.midgard.getKillDaily(input),{date,characterKey});
async function capture(name){await page.waitForTimeout(200);await page.screenshot({path:path.join(output,name),fullPage:true});screenshots.push(name);}
async function launch(){
  app=await electron.launch({...(process.argv[2]?{executablePath:path.resolve(process.argv[2]),args:[]}:{args:['.']}),env,timeout:30000});
  page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));await page.waitForFunction(()=>!!window.midgard);
  await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows()[0].setSize(1480,1000));
  await page.getByRole('navigation',{name:'Ana gezinme'}).getByRole('button',{name:'Kill Count',exact:true}).click();await panel().waitFor();
  await wait(page,async()=>(await window.midgard.getState()).expansion.killCount.totals.observedDeaths===12);
}
async function chooseDate(date){await dateInput().fill(date);await page.waitForFunction(value=>document.querySelector('input[aria-label="Kill Count günü"]')?.value===value,date);}
async function expectRows(count){await page.waitForFunction(value=>document.querySelectorAll('tr[data-kill-monster]').length===value,count);}
async function geometry(label,{detail=false}={}){
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${label}: no document horizontal overflow`);
  const daily=page.locator('.kill-daily-panel');
  check(await daily.evaluate(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth+1;}),`${label}: daily date controls remain inside viewport`);
  if(detail)check(await page.locator('.kill-detail').evaluate(node=>node.getBoundingClientRect().bottom<=innerHeight+2),`${label}: detail pane remains inside viewport`);
}
try{
  await launch();const original=await state(),originalKills=JSON.stringify(original.expansion.killCount.totals),originalFinance=JSON.stringify(original.expansion.finance),financeView=JSON.stringify(await page.evaluate(()=>window.midgard.getFinanceView()));
  const expectedVersion=JSON.parse(await readFile(path.resolve('package.json'),'utf8')).version;
  check((await page.locator('.assistant-sidebar').innerText()).includes(`v${expectedVersion}`),`The sidebar displays the delivered v${expectedVersion} version`);
  await expectRows(4);check(await rowCount(1313)===5,'All-time Mobster count includes dated and undated observations');
  const fifth=await apiDaily('2026-11-05'),fourth=await apiDaily('2026-11-04');
  check(fifth.timeZone==='Europe/Istanbul'&&fifth.totals.observedDeaths===7&&fourth.totals.observedDeaths===3,'IPC daily totals split precisely at Turkish local midnight');
  check(fifth.undatedDeaths===2&&fourth.undatedDeaths===2,'Observation-anchor rows stay outside all calendar days');
  check(fifth.totals.durationMs===120*60000&&fourth.totals.durationMs===60000,'Overlapping source and character spans count once and are clipped at midnight');
  check(fifth.days.length===7&&fifth.days.at(-1).date==='2026-11-05'&&fifth.days.at(-2).observedDeaths===3,'Daily strip exposes seven calendar totals ending on the selected date');
  check((await apiDaily('2026-11-05',keys[0])).totals.observedDeaths===5,'IPC daily character scope selects only that character');
  const invalid=await page.evaluate(async()=>{try{await window.midgard.getKillDaily({date:'2026-02-30'});return false;}catch{return true;}});check(invalid,'Daily IPC rejects impossible calendar dates');
  await panel().getByRole('button',{name:'Günlük',exact:true}).click();await dateInput().waitFor();await chooseDate('2026-11-05');await expectRows(4);
  await page.waitForFunction(()=>document.querySelector('tr[data-kill-monster="1313"] .kill-count-cell strong')?.textContent==='2');
  check(await rowCount(1317)===3&&await rowCount(1313)===2&&await rowCount(2829)===1&&await rowCount(1391)===1,'Daily list shows only selected-day monster counts');
  const visibleRows=await page.locator('.kill-table-scroll').evaluate(node=>{const r=node.getBoundingClientRect();return [...node.querySelectorAll('tr[data-kill-monster]')].filter(row=>{const q=row.getBoundingClientRect();return q.top>=r.top-1&&q.bottom<=r.bottom+1;}).length;});
  check(visibleRows>=3,'The standard desktop daily view keeps at least three full monster rows visible');
  await page.locator('.kill-table-scroll').evaluate(node=>{node.scrollTop=node.scrollHeight;});
  check(await rows().last().evaluate(row=>{const q=row.getBoundingClientRect(),r=row.closest('.kill-table-scroll').getBoundingClientRect();return q.top>=r.top-1&&q.bottom<=r.bottom+1;}),'The final daily row remains reachable through the internal list scroll');
  await page.locator('.kill-table-scroll').evaluate(node=>{node.scrollTop=0;});
  check((await page.locator('.kill-daily-undated').innerText()).includes('2 gözlem'),'Daily UI explains observations without a reliable calendar date');
  const pollingDb=new DatabaseSync(database),pollingId='qa-daily-temporary-poll',pollingRecording=createHash('sha256').update('qa-daily-a').digest('hex');
  try{
    pollingDb.prepare('INSERT INTO kill_count_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(pollingId,'qa-daily-a',keys[0],pollingRecording,1313,999999,'qa-daily-temporary-life',90000,0,stamp,'SYNTHETIC-poll','Mobster','{}');
    await page.waitForFunction(()=>document.querySelector('tr[data-kill-monster="1313"] .kill-count-cell strong')?.textContent==='3',null,{timeout:12000});
    check(await rowCount(1313)===3,'Automatic daily polling shows newly stored observations without a refresh click');
    pollingDb.prepare('DELETE FROM kill_count_events WHERE id=?').run(pollingId);
    await page.waitForFunction(()=>document.querySelector('tr[data-kill-monster="1313"] .kill-count-cell strong')?.textContent==='2',null,{timeout:12000});
    check(await rowCount(1313)===2,'Automatic daily polling replaces an obsolete result after the test event is removed');
  }finally{pollingDb.prepare('DELETE FROM kill_count_events WHERE id=?').run(pollingId);pollingDb.close();}
  await panel().getByRole('button',{name:'Önceki gün',exact:true}).click();await page.waitForFunction(()=>document.querySelector('input[aria-label="Kill Count günü"]')?.value==='2026-11-04');await expectRows(2);
  check(await rowCount(1317)===2&&await rowCount(1313)===1,'Previous-day control changes every displayed monster count');
  await panel().getByRole('button',{name:'Sonraki gün',exact:true}).click();await page.waitForFunction(()=>document.querySelector('input[aria-label="Kill Count günü"]')?.value==='2026-11-05');await expectRows(4);
  await page.locator('[data-kill-day="2026-11-04"]').click();await expectRows(2);check(await dateInput().inputValue()==='2026-11-04'&&await rowCount(1313)===1,'A day tile selects its date and replaces the monster breakdown');
  await chooseDate('2026-11-03');await expectRows(0);await page.waitForFunction(()=>/gözlem yok|veri yok/.test(document.querySelector('.kill-empty h3')?.textContent??''));check(true,'An empty day has an explicit empty state');
  await chooseDate('0001-01-07');await expectRows(0);check(await page.locator('[data-kill-day]:disabled').count()===6&&await panel().getByRole('button',{name:'Önceki gün',exact:true}).isDisabled(),'The minimum supported date disables every earlier tile and previous-day navigation');
  await chooseDate('2026-11-05');await expectRows(4);
  await page.getByRole('combobox',{name:'Kill Count karakteri',exact:true}).selectOption(keys[0]);await page.waitForFunction(()=>document.querySelector('tr[data-kill-monster="1313"] .kill-count-cell strong')?.textContent==='1');
  check(await rowCount(1317)===2&&await rowCount(1313)===1,'UI character selection filters daily counts');
  await page.getByRole('combobox',{name:'Kill Count karakteri',exact:true}).selectOption('all');await page.waitForFunction(()=>document.querySelector('tr[data-kill-monster="1313"] .kill-count-cell strong')?.textContent==='2');
  await search().fill('Mobster');await expectRows(1);await rows().getByRole('button',{name:'Mobster favorilere ekle',exact:true}).click();await wait(page,async()=>(await window.midgard.getKillView()).favoriteIds.includes(1313));
  await search().fill('');await panel().getByRole('button',{name:'Favoriler',exact:true}).click();await expectRows(1);check(await rowCount(1313)===2,'Favorites filter retains the selected-day monster count');
  await panel().getByRole('button',{name:'Favoriler',exact:true}).click();await expectRows(4);await page.locator('tr[data-kill-monster="1313"]').getByRole('button',{name:'Mobster ayrıntılarını aç',exact:true}).click();await page.locator('.kill-detail').waitFor();
  const raw=page.locator('.kill-raw-detail');if(await raw.getAttribute('open')===null)await raw.locator('summary').click();await page.waitForFunction(()=>document.querySelectorAll('.kill-raw-detail .kill-detail-events li').length===2);
  check(await page.locator('.kill-rhythm').count()===0,'Daily detail does not display unrelated all-time target rhythm');
  await geometry('1480px daily detail',{detail:true});await page.getByRole('button',{name:'Siyah tema',exact:true}).click();await capture('kill-daily-dark-detail-1480.png');
  await page.locator('.kill-detail').getByRole('button',{name:'Günün geçmişini aç',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('tr[data-kill-event]').length===2);
  check(await page.getByRole('combobox',{name:'Kill Count kaydı',exact:true}).count()===0,'Daily event history does not expose a conflicting full-record selector');
  const datedEvents=await page.evaluate(()=>window.midgard.getKillEvents({date:'2026-11-05',monsterId:1313,limit:25}));
  check(datedEvents.items.length===2&&datedEvents.items.every(event=>event.eventAt>='2026-11-04T21:00:00.000Z'&&event.eventAt<'2026-11-05T21:00:00.000Z'),'Daily monster history and raw event API use the identical date interval');
  await capture('kill-daily-history-dark-1480.png');await panel().getByRole('tab',{name:'Canlı',exact:true}).click();await page.getByRole('button',{name:'Yaratık ayrıntılarını kapat',exact:true}).click();await search().fill('');
  await page.getByRole('button',{name:'Açık tema',exact:true}).click();await capture('kill-daily-light-1480.png');await geometry('1480px light');
  await page.getByRole('button',{name:'Siyah tema',exact:true}).click();await capture('kill-daily-dark-1480.png');
  await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows()[0].setMinimumSize(480,600));
  for(const [width,height] of [[1100,820],[820,800],[620,800]]){
    await app.evaluate(({BaseWindow},size)=>BaseWindow.getAllWindows()[0].setSize(...size),[width,height]);await page.waitForTimeout(100);await geometry(`${width}px dark`);await capture(`kill-daily-dark-${width}.png`);
  }
  await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows()[0].setSize(1480,1000));
  await panel().getByRole('button',{name:'Bugün',exact:true}).click();const today=await page.evaluate(()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));await page.waitForFunction(value=>document.querySelector('input[aria-label="Kill Count günü"]')?.value===value,today);
  await wait(page,async()=>(await window.midgard.getKillView()).dailyDate===null);check((await prefs()).dailyDate===null,'Today control follows the current local day instead of freezing a saved date');
  await chooseDate('2026-11-05');await expectRows(4);
  // Main-process injection is confined to the synthetic app to exercise response races and failure recovery.
  await app.evaluate(({ipcMain})=>{
    const channel='midgard:kill-daily',original=ipcMain._invokeHandlers.get(channel);if(!original)throw new Error('Daily QA could not locate the IPC handler');
    globalThis.__qaDailyOriginal=original;ipcMain.removeHandler(channel);
    ipcMain.handle(channel,async(event,input)=>{if(input.date==='2026-11-04')await new Promise(resolve=>setTimeout(resolve,450));if(input.date==='2026-11-03')throw new Error('SYNTHETIC günlük okuma hatası');return original(event,input);});
  });
  await chooseDate('2026-11-04');await chooseDate('2026-11-05');await expectRows(4);await page.waitForTimeout(650);check(await dateInput().inputValue()==='2026-11-05'&&await rowCount(1313)===2,'A delayed old-date response never replaces the newer selected date');
  await chooseDate('2026-11-03');await panel().getByRole('alert').filter({hasText:'SYNTHETIC günlük okuma hatası'}).waitFor();check(await rows().count()===0,'A daily read failure clears the preceding date rows instead of presenting stale counts');
  await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('midgard:kill-daily');ipcMain.handle('midgard:kill-daily',globalThis.__qaDailyOriginal);delete globalThis.__qaDailyOriginal;});
  await chooseDate('2026-11-05');await expectRows(4);check(await rowCount(1313)===2,'Selecting a valid day recovers from a daily read error');
  await panel().getByRole('button',{name:'Tümü',exact:true}).click();await page.waitForFunction(()=>document.querySelector('tr[data-kill-monster="1313"] .kill-count-cell strong')?.textContent==='5');
  check(JSON.stringify((await state()).expansion.killCount.totals)===originalKills,'Every date, filter, favorite, history and error transition leaves aggregate kill accounting untouched');
  check(JSON.stringify((await state()).expansion.finance)===originalFinance&&JSON.stringify(await page.evaluate(()=>window.midgard.getFinanceView()))===financeView,'Daily Kill Count leaves the finance ledger and view preferences untouched');
  await panel().getByRole('button',{name:'Günlük',exact:true}).click();await chooseDate('2026-11-04');await expectRows(2);await wait(page,async()=>(await window.midgard.getKillView()).dailyDate==='2026-11-04');const saved=await prefs();
  await app.close();app=null;await launch();await dateInput().waitFor();await expectRows(2);check(JSON.stringify(await prefs())===JSON.stringify(saved)&&await rowCount(1313)===1,'Daily mode, historical date and favorites survive a clean restart');
  check(JSON.stringify((await state()).expansion.killCount.totals)===originalKills,'Restart does not replay or recount archived observations');check(errors.length===0,'No renderer errors');
  const report={output,executable:process.argv[2]?path.resolve(process.argv[2]):'source electron .',passed:checks.length,checks,rendererErrors:errors,screenshots,scope:'Synthetic SQLite archive only. No user profile, actual Replay or game client was touched.'};await writeFile(path.join(output,'kill-daily-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await writeFile(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:String(error),stack:error.stack},null,2));try{await capture('failure.png');}catch{}throw error;}finally{await app?.close();}
