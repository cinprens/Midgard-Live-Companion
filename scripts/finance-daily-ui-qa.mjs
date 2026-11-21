import {_electron as electron} from 'playwright';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {wait} from './qa-wait.mjs';
import {seedFinanceDaily,financeDailyDate,financeDailyKeys,financeDailyAnchor,financeDailyStamp} from './finance-daily-fixtures.mjs';

// Native QA controls only its generated profile; no real profile or Replay is opened.
const startedAt=Date.now(),output=path.resolve('.qa',`finance-daily-${startedAt}`),profile=path.join(output,'profile');await mkdir(profile,{recursive:true});
await build({entryPoints:['electron/expansion-store.ts'],outfile:path.join(output,'store.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24',external:['node:*'],logLevel:'error'});
const {ExpansionStore}=createRequire(import.meta.url)(path.join(output,'store.cjs'));
const database=path.join(profile,'midgard-live.sqlite'),seed=new ExpansionStore(database);
seed.financeCommand({type:'price.set',price:{itemId:501,itemName:'QA Korunan Defter',characterKey:null,npcPrice:null,marketPrice:42,buyCost:null,method:'market'}});
seed.setSetting('finance-view',{version:1,favoriteIds:[746],hiddenIds:[],characterKey:null,tab:'all',sort:'value-desc',pageSize:50});
seed.setSetting('kill-view',{version:1,favoriteIds:[1313],pinnedTargetId:1313,characterKey:null,tab:'live',sort:'count-desc',pageSize:50,onlyFavorites:false,recordingKey:null,scopeMode:'daily',dailyDate:financeDailyDate});
seed.close();seedFinanceDaily(database);
await writeFile(path.join(profile,'live-preferences.json'),JSON.stringify({version:1,sources:[],manualBindings:[],soundPaths:{},alerts:{muted:true,selectedCardIds:[],selectedMonsterIds:[1313],cityMaps:[],volume:0,weightThreshold:65,enabled:{death:true,weight:true,card:true,city:true,level:true,monster:true}}}));
const env={...process.env,MIDGARD_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.MIDGARD_DEV_URL;
let app,page;const checks=[],errors=[],screenshots=[];
const check=(value,label)=>{assert.ok(value,label);checks.push(label);};
const state=()=>page.evaluate(()=>window.midgard.getState());
const prefs=()=>page.evaluate(()=>window.midgard.getFinanceView());
const daily=(date=financeDailyDate,characterKey=null)=>page.evaluate(query=>window.midgard.getFinanceDaily(query),{date,characterKey});
const panel=()=>page.locator('.finance-workspace');
const period=()=>page.getByRole('group',{name:'Finans dönemi',exact:true});
const rows=()=>panel().locator('tr[data-farm-item-id]');
const dateInput=()=>page.getByLabel('Finans günü',{exact:true});
const character=()=>page.getByRole('combobox',{name:'Karakter seç',exact:true});
const field=id=>page.locator(`.finance-detail input[data-price-item-id="${id}"]`);
const rowQuantity=async id=>Number((await panel().locator(`tr[data-farm-item-id="${id}"] .finance-item-quantity`).innerText()).replaceAll('.','').replace(',','.'));
async function launch(){
  app=await electron.launch({...(process.argv[2]?{executablePath:path.resolve(process.argv[2]),args:[]}:{args:['.']}),env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
  await page.getByRole('navigation',{name:'Ana gezinme'}).getByRole('button',{name:'Finans',exact:true}).click();await panel().waitFor();await rows().first().waitFor();
}
async function chooseDate(date){await dateInput().fill(date);await dateInput().dispatchEvent('change');await page.waitForFunction(value=>document.querySelector('input[aria-label="Finans günü"]')?.value===value,date);}
async function quantity(id,expected){await page.waitForFunction(({id,expected})=>Number(document.querySelector(`tr[data-farm-item-id="${id}"] .finance-item-quantity`)?.textContent?.replaceAll('.','').replace(',','.'))===expected,{id,expected});}
async function openItem(id,name){await page.locator(`tr[data-farm-item-id="${id}"]`).getByRole('button',{name:`${name} ayrıntılarını aç`,exact:true}).click();await field(id).waitFor();}
async function closeDetail(){if(await page.getByRole('button',{name:'Eşya ayrıntılarını kapat',exact:true}).count())await page.getByRole('button',{name:'Eşya ayrıntılarını kapat',exact:true}).click();}
async function theme(value){await page.getByRole('button',{name:value==='dark'?'Siyah tema':'Açık tema',exact:true}).click();await page.waitForFunction(expected=>document.querySelector('.assistant-shell')?.getAttribute('data-theme')===expected,value);await page.waitForTimeout(250);}
async function capture(name){const file=path.join(output,name);await page.screenshot({path:file,fullPage:false});screenshots.push(file);}
async function geometry(label,{detail=false}={}){
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${label}: no horizontal document overflow`);
  check(await page.locator('.finance-daily-panel').evaluate(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;}),`${label}: calendar controls fit viewport`);
  if(detail)check(await page.locator('.finance-detail').evaluate(node=>node.getBoundingClientRect().bottom<=innerHeight+2),`${label}: detail pane stays within viewport`);
}
function storedArchive(){const db=new DatabaseSync(database,{readOnly:true});try{return JSON.stringify({receipts:db.prepare('SELECT * FROM autofarm_receipts ORDER BY id').all(),totals:db.prepare('SELECT * FROM autofarm_item_totals ORDER BY character_key,item_id').all(),sessions:db.prepare('SELECT id,character_key,recording_key,time_basis FROM autofarm_sessions ORDER BY id').all()});}finally{db.close();}}
try{
  await launch();const initial=await state(),originalTotals=JSON.stringify(initial.expansion.autoFarm.totals),originalFinance=JSON.stringify(initial.expansion.finance),killPrefs=JSON.stringify(await page.evaluate(()=>window.midgard.getKillView())),archive=storedArchive();
  const oldView=await prefs();check(oldView.scopeMode==='all'&&oldView.dailyDate===null&&oldView.favoriteIds.join()==='746','Legacy finance preferences upgrade to all-time without losing favorite IDs');
  check(await rowQuantity(603)===15&&initial.expansion.autoFarm.totals.quantity===47,'All-time finances include dated and undated retained receipts');
  const today=await daily(),yesterday=await daily('2026-11-04');
  check(today.timeZone==='Europe/Istanbul'&&today.totals.quantity===31&&yesterday.totals.quantity===7,'Receipt timestamps split at Istanbul midnight, independently of import date');
  check(today.totals.knownValue===150400&&today.totals.unpricedQuantity===4&&today.totals.partial&&today.items.find(item=>item.itemId===507)?.value===0,'Current shared prices distinguish unknown values from a true zero');
  check(today.undatedQuantity===9&&yesterday.undatedQuantity===9,'Unknown acquisition dates stay outside daily quantities');
  check(today.totals.durationMs===120*60000&&yesterday.totals.durationMs===60000,'Overlapping source coverage is unioned and clipped at midnight');
  check(today.days.length===7&&today.days.at(-1).quantity===31&&today.days.at(-2).knownValue===73250,'Seven-day strip carries date-scoped quantity, value and partial-price state');
  check((await daily(financeDailyDate,financeDailyKeys[0])).totals.quantity===24&&(await daily(financeDailyDate,financeDailyKeys[1])).totals.durationMs===60*60000,'Daily API scopes quantities and duration by character');
  const invalid=await page.evaluate(async()=>{for(const query of [{date:'2026-02-30'},{date:'2026-11-05',characterKey:'bad\nkey'},{date:'2026-11-05',unknown:true}]){try{await window.midgard.getFinanceDaily(query);return false;}catch{}}return true;});check(invalid,'Daily API validates actual dates, character keys and unknown fields');
  await period().getByRole('button',{name:'Günlük',exact:true}).click();await chooseDate(financeDailyDate);await quantity(603,4);
  check(await rows().count()===4&&await rowQuantity(746)===16,'Daily table contains only the selected day receipts');
  check(await page.locator('.finance-stat').count()===3,'Daily finance retains exactly three compact KPI cards');
  check((await page.locator('.finance-daily-undated').innerText()).includes('9'),'UI explains the undated quantity');
  check((await page.locator('.finance-daily-panel').innerText()).toLocaleLowerCase('tr-TR').includes('güncel'),'Calendar explains that values use current prices');
  const polling=new DatabaseSync(database);
  try{
    polling.prepare('INSERT INTO autofarm_receipts(id,session_id,character_key,item_id,quantity,event_ms,recorded_at,source_hash,inventory_source,confidence,item_name,excluded_reason,decoder_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('qa-finance-poll','qa-finance-daily-b',financeDailyKeys[1],603,2,120000,financeDailyStamp,'SYNTHETIC-poll','inventory-delta','decoded-skadi-unverified','Old Blue Box',null,2);
    await quantity(603,6);check(true,'Five-second polling shows newly archived daily receipts without a user refresh');
    polling.prepare('DELETE FROM autofarm_receipts WHERE id=?').run('qa-finance-poll');await quantity(603,4);check(true,'Polling replaces a superseded daily result');
  }finally{polling.close();}
  await page.getByRole('button',{name:'Önceki finans günü',exact:true}).click();await quantity(603,2);check(await rowQuantity(746)===5,'Previous-day navigation updates every daily row');
  await chooseDate(financeDailyDate);await quantity(603,4);await page.locator('[data-finance-day="2026-11-04"]').click();await quantity(603,2);check(true,'A seven-day tile selects its calendar date');
  await chooseDate('2026-11-03');await page.waitForFunction(()=>document.querySelectorAll('tr[data-farm-item-id]').length===0);
  check((await daily('2026-11-03')).totals.knownValue===0&&!(await page.locator('.finance-empty').innerText()).includes('Envanter verisi bekleniyor'),'Empty dates show an empty daily result rather than waiting for initial inventory');
  await chooseDate(financeDailyDate);await quantity(603,4);await character().selectOption(financeDailyKeys[0]);await quantity(603,3);check(await rowQuantity(746)===10,'Character selection filters the daily list');
  await character().selectOption('');await quantity(603,4);await openItem(603,'Old Blue Box');
  check((await page.locator('.finance-detail-quantity').innerText()).includes('4 adet')&&(await page.locator(`[data-detail-character="${financeDailyKeys[0]}"]`).innerText()).includes('3 adet')&&(await page.locator(`[data-detail-character="${financeDailyKeys[1]}"]`).innerText()).includes('1 adet'),'Detail total and both character distributions use the selected day');
  await field(603).fill('-1');await chooseDate('2026-11-04');await quantity(603,2);check(await page.locator('.finance-detail').count()===0,'Changing date closes old detail quantities');await openItem(603,'Old Blue Box');
  check(await field(603).inputValue()==='-1','An unsaved invalid price draft survives a date change without becoming a stored price');
  for(const [input,value,expectedKnown]of [['0',0,3250],['',null,3250],['35.000',35000,73250]]){
    await field(603).fill(input);await field(603).press('Tab');await wait(page,async({id,value})=>(await window.midgard.getState()).expansion.autoFarm.prices.find(item=>item.itemId===id)?.unitPrice===value,{id:603,value});
    check((await daily('2026-11-04')).totals.knownValue===expectedKnown,`Historical date recalculates with the current shared price ${String(value)}`);
  }
  await field(603).fill('40.000');await field(603).press('Tab');await wait(page,async()=>(await window.midgard.getState()).expansion.autoFarm.prices.find(item=>item.itemId===603)?.unitPrice===40000);
  check((await daily()).totals.knownValue===170400&&(await state()).expansion.autoFarm.totals.knownValue===613650,'Editing a daily price updates daily and all-time valuation while retaining quantities');
  await field(603).fill('35.000');await field(603).press('Tab');await wait(page,async()=>(await window.midgard.getState()).expansion.autoFarm.prices.find(item=>item.itemId===603)?.unitPrice===35000);await closeDetail();
  await chooseDate(financeDailyDate);await quantity(603,4);
  const incomplete=new DatabaseSync(database);
  try{
    incomplete.prepare('DELETE FROM finance_calendar_intervals WHERE interval_id=?').run('qa-finance-daily-overlap');
    await page.waitForFunction(()=>document.querySelectorAll('.finance-stat')[1]?.textContent?.includes('Takip süresi eksik'));
    check((await daily()).durationPartial&&(await daily()).totals.knownHourlyValue===null,'Missing historical coverage suppresses hourly valuation without dropping dated quantities');
    await openItem(603,'Old Blue Box');await field(603).fill('40.000');await field(603).press('Tab');await wait(page,async()=>(await window.midgard.getState()).expansion.autoFarm.prices.find(item=>item.itemId===603)?.unitPrice===40000);
    check(await page.locator('.finance-stat').nth(1).locator('strong').innerText()==='—','Live price overrides cannot recreate an hourly value from incomplete duration');
    await field(603).fill('35.000');await field(603).press('Tab');await wait(page,async()=>(await window.midgard.getState()).expansion.autoFarm.prices.find(item=>item.itemId===603)?.unitPrice===35000);await closeDetail();
    incomplete.prepare('INSERT INTO finance_calendar_intervals VALUES(?,?,?,?)').run('qa-finance-daily-overlap','qa-finance-daily-a',financeDailyAnchor+30000,financeDailyAnchor+120*60000);
    await page.waitForFunction(()=>!document.querySelectorAll('.finance-stat')[1]?.textContent?.includes('Takip süresi eksik'));
  }finally{incomplete.close();}
  await panel().getByRole('tab',{name:/^Favoriler/}).click();await page.waitForFunction(()=>document.querySelectorAll('tr[data-farm-item-id]').length===1);check(await rowQuantity(746)===16,'Existing favorite tab keeps the daily date scope');await panel().getByRole('tab',{name:/^Tümü/}).click();await quantity(603,4);
  await theme('dark');await geometry('1480 dark');
  check(await page.locator('.finance-table-scroll').evaluate(node=>{const r=node.getBoundingClientRect();return [...node.querySelectorAll('tr[data-farm-item-id]')].filter(row=>{const q=row.getBoundingClientRect();return q.top>=r.top-1&&q.bottom<=r.bottom+1;}).length>=3;}),'Desktop daily view retains at least three complete item rows');await capture('finance-daily-dark-1480.png');
  await openItem(603,'Old Blue Box');await geometry('1480 dark detail',{detail:true});await capture('finance-daily-dark-detail-1480.png');await closeDetail();
  await theme('light');await capture('finance-daily-light-1480.png');
  await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows()[0].setMinimumSize(480,600));
  for(const [width,height]of [[1100,820],[620,800]]){
    await app.evaluate(({BaseWindow},size)=>BaseWindow.getAllWindows()[0].setSize(...size),[width,height]);await page.waitForTimeout(120);await geometry(`${width} light`);await capture(`finance-daily-light-${width}.png`);
    await theme('dark');await geometry(`${width} dark`);await capture(`finance-daily-dark-${width}.png`);await theme('light');
  }
  await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows()[0].setSize(1480,980));
  await page.getByRole('button',{name:'Bugün',exact:true}).click();await wait(page,async()=>(await window.midgard.getFinanceView()).dailyDate===null);check(true,'Today remains a moving selection instead of freezing the current date');
  await chooseDate(financeDailyDate);await quantity(603,4);
  await app.evaluate(({ipcMain})=>{const channel='midgard:finance-daily';globalThis.__qaFinanceDailyOriginal=ipcMain._invokeHandlers.get(channel);ipcMain.removeHandler(channel);ipcMain.handle(channel,async(event,input)=>{if(input.date==='2026-11-04')await new Promise(resolve=>setTimeout(resolve,450));if(input.date==='2026-11-03')throw new Error('SYNTHETIC günlük finans okuma hatası');return globalThis.__qaFinanceDailyOriginal(event,input);});});
  await chooseDate('2026-11-04');await chooseDate(financeDailyDate);await quantity(603,4);await page.waitForTimeout(650);check(await rowQuantity(603)===4&&await dateInput().inputValue()===financeDailyDate,'A slow old-date response never replaces the current day');
  await chooseDate('2026-11-03');await panel().getByRole('alert').filter({hasText:'SYNTHETIC günlük finans okuma hatası'}).waitFor();check(await rows().count()===0,'A daily error clears the preceding date amounts');
  await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('midgard:finance-daily');ipcMain.handle('midgard:finance-daily',globalThis.__qaFinanceDailyOriginal);delete globalThis.__qaFinanceDailyOriginal;});
  await chooseDate(financeDailyDate);await quantity(603,4);check(true,'Selecting a valid date recovers after a read error');
  await period().getByRole('button',{name:'Tümü',exact:true}).click();await quantity(603,15);check(JSON.stringify((await state()).expansion.autoFarm.totals)===originalTotals,'Returning to all-time restores the unchanged original finance totals');
  check(storedArchive()===archive&&JSON.stringify((await state()).expansion.finance)===originalFinance,'Daily queries and price editing preserve receipt quantities and legacy finance ledger');
  check(JSON.stringify(await page.evaluate(()=>window.midgard.getKillView()))===killPrefs,'Finance daily preferences leave Kill Count preferences unchanged');
  await period().getByRole('button',{name:'Günlük',exact:true}).click();await chooseDate('2026-11-04');await quantity(603,2);await wait(page,async()=>(await window.midgard.getFinanceView()).dailyDate==='2026-11-04');const saved=await prefs();
  await app.close();app=null;await launch();await dateInput().waitFor();await quantity(603,2);check(JSON.stringify(await prefs())===JSON.stringify(saved),'Daily mode, selected date and old favorites survive a native restart');
  check(storedArchive()===archive,'Restart does not recount archived receipts');check(errors.length===0,'No renderer exceptions');
  const report={startedAt:new Date(startedAt).toISOString(),finishedAt:new Date().toISOString(),durationMs:Date.now()-startedAt,output,executable:process.argv[2]?path.resolve(process.argv[2]):'source electron .',passed:checks.length,checks,rendererErrors:errors,screenshots,scope:'Synthetic receipt/calendar archive and isolated profile only. No real profile, Replay or game client touched.'};await writeFile(path.join(output,'finance-daily-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await writeFile(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:String(error),stack:error.stack},null,2));try{await capture('failure.png');}catch{}throw error;}finally{await app?.close();}
