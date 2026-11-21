import {_electron as electron} from 'playwright';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {seedHuntAnalytics,analyticsKeys,analyticsNames,analyticsDate} from './hunt-analytics-fixtures.mjs';
import {wait} from './qa-wait.mjs';

const output=path.resolve('.qa',`hunt-analytics-${Date.now()}`),profile=path.join(output,'profile');
await mkdir(profile,{recursive:true});
await build({entryPoints:['electron/expansion-store.ts'],outfile:path.join(output,'store.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24',external:['node:*'],logLevel:'error'});
const {ExpansionStore}=createRequire(import.meta.url)(path.join(output,'store.cjs'));
const database=path.join(profile,'midgard-live.sqlite'),seed=new ExpansionStore(database);
seed.setSetting('hunt-analytics-view',{version:1,characterKey:analyticsKeys[0],sharedCharacterKeys:[],scope:'character',monsterId:1313,reference:'previous-day',trendDays:7,metric:'rate'});
seed.setSetting('kill-view',{version:1,favoriteIds:[1313],pinnedTargetId:1313,characterKey:null,tab:'live',sort:'count-desc',pageSize:50,onlyFavorites:false,recordingKey:null,scopeMode:'daily',dailyDate:analyticsDate});
seed.financeCommand({type:'price.set',price:{itemId:501,itemName:'QA Korunan Fiyat',characterKey:null,npcPrice:null,marketPrice:42,buyCost:null,method:'market'}});
seed.close();seedHuntAnalytics(database);
await writeFile(path.join(profile,'live-preferences.json'),JSON.stringify({version:1,sources:[],manualBindings:[],soundPaths:{},alerts:{muted:true,selectedCardIds:[],selectedMonsterIds:[1313],cityMaps:[],volume:0,weightThreshold:65,enabled:{death:true,weight:true,card:true,city:true,level:true,monster:true}}}));
const env={...process.env,MIDGARD_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.MIDGARD_DEV_URL;
const checks=[],errors=[],screenshots=[];let app,page;
const check=(condition,label)=>{assert.ok(condition,label);checks.push(label);};
const query={monsterId:1313,date:analyticsDate,scope:{kind:'character',characterKey:analyticsKeys[0]},reference:'previous-day',trendDays:7};
const getAnalytics=value=>page.evaluate(q=>window.midgard.getHuntAnalytics(q),value??query);
const sheet=()=>page.getByRole('dialog',{name:'Av analizi'});
async function launch(){app=await electron.launch({...(process.argv[2]?{executablePath:path.resolve(process.argv[2]),args:[]}:{args:['.']}),env});page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.getByRole('button',{name:'Kill Count',exact:true}).click();await page.locator('[data-hunt-analytics]').waitFor();await page.waitForFunction(()=>document.querySelector('[data-analytics-metric="count"]')?.textContent==='60');}
async function capture(name){const file=path.join(output,name);await page.screenshot({path:file,fullPage:false});screenshots.push(file);}
async function closeSheet(){await page.getByLabel('Av analizini kapat').click();await sheet().waitFor({state:'hidden'});}
async function openSheet(){await page.getByRole('button',{name:'Analiz',exact:true}).click();await sheet().waitFor();}
async function size(width,height){await app.evaluate(({BaseWindow},[w,h])=>{const win=BaseWindow.getAllWindows()[0];win.setMinimumSize(400,600);win.setSize(w,h);},[width,height]);await page.waitForTimeout(120);}
try{
  await launch();
  const before=await page.evaluate(()=>window.midgard.getState()),finance=JSON.stringify(before.expansion.finance),totals=JSON.stringify(before.expansion.killCount.totals),notifications=JSON.stringify(before.assistance.preferences.selectedMonsterIds);
  const current=await getAnalytics();check(current.current.observations===60&&current.current.durationMs===4*3600000&&current.current.ratePerHour===15,'Real worker computes 60 observations / 4 Replay hours');
  check(current.comparison.eligible&&current.comparison.countChangePercent===50&&current.comparison.rateChangePercent===-25,'40/2h to 60/4h yields +50% count and -25% tempo');
  check(await page.locator('.kill-kpis > *').count()===3,'Overview still has exactly three KPI cards');
  check((await page.locator('[data-analytics-metric="change"]').innerText()).includes('25'),'Compact strip shows rate change');
  const polling=new DatabaseSync(database);
  try{
    polling.exec("BEGIN; INSERT INTO hunt_analytics_events SELECT 'qa-poll-event',recording_key,character_key,monster_id,monster_name,map_id,999999,event_ms+5,replay_ms+5,segment_id,provenance FROM hunt_analytics_events WHERE id='event-analytics-0-0-0'; UPDATE hunt_analytics_metadata SET value=value+1 WHERE key='revision'; COMMIT;");
    await page.waitForFunction(()=>document.querySelector('[data-analytics-metric="count"]')?.textContent==='61',null,{timeout:12000});
    check(true,'Automatic analytics refresh invalidates the worker cache when data changes');
    polling.exec("BEGIN; DELETE FROM hunt_analytics_events WHERE id='qa-poll-event'; UPDATE hunt_analytics_metadata SET value=value+1 WHERE key='revision'; COMMIT;");
    await page.waitForFunction(()=>document.querySelector('[data-analytics-metric="count"]')?.textContent==='60',null,{timeout:12000});
    check(true,'Refresh replaces obsolete observations without a manual reload');
  }finally{polling.close();}
  await openSheet();check(await page.getByLabel('Av analizini kapat').evaluate(node=>node===document.activeElement),'Sheet focuses its close control');
  check((await sheet().innerText()).includes('kişisel kesim kanıtı'),'Sheet states observational evidence limitation');
  await page.getByLabel('Analiz referansı').selectOption('previous-7-days');
  await wait(page,async()=>(await window.midgard.getHuntAnalyticsPreferences()).reference==='previous-7-days');
  await page.getByRole('group',{name:'Eğilim süresi'}).getByRole('button',{name:'28 gün',exact:true}).click();
  await page.getByRole('img',{name:/28 günlük/}).waitFor();check(true,'28-day trend uses a single accessible chart');
  await page.getByRole('group',{name:'Grafik ölçümü'}).getByRole('button',{name:'Adet',exact:true}).click();
  await page.getByRole('img',{name:/28 günlük Ölüm gözlemi/}).waitFor();check(true,'Count and tempo chart modes are selectable');
  await page.getByRole('tab',{name:'Kayıtlar',exact:true}).click();await page.locator('[data-analytics-evidence]').first().waitFor();
  check(await page.locator('[data-analytics-evidence]').count()===25,'Evidence is paginated to 25 entries');
  await page.getByLabel('Sonraki analiz kayıtları').click();await page.getByText('Sayfa 2',{exact:false}).waitFor();check(true,'Evidence next page is reachable');
  await page.getByRole('group',{name:'Analiz kapsamı'}).getByRole('button',{name:'Tahmini ortak',exact:true}).click();
  for(const name of analyticsNames)await sheet().getByRole('checkbox',{name,exact:true}).check();
  await wait(page,async()=>(await window.midgard.getHuntAnalyticsPreferences()).sharedCharacterKeys.length===3);
  const shared=await getAnalytics({...query,scope:{kind:'shared',characterKeys:analyticsKeys}});
  check(shared.current.observations===60&&shared.current.durationMs===4*3600000,'Three sources observing the same deaths yield 60 shared candidates, not 180');
  await page.getByRole('tab',{name:'Ritim',exact:true}).click();await page.getByRole('heading',{name:'Gözlem ritmi',exact:true}).waitFor();
  check(shared.rhythm.validIntervals>=5&&shared.rhythm.medianMs>0,'Shared rhythm has covered same-map intervals');
  await page.getByLabel('Analiz yaratığı').selectOption('1317');
  await wait(page,async()=>(await window.midgard.getHuntAnalyticsPreferences()).monsterId===1317);
  check(JSON.stringify((await page.evaluate(()=>window.midgard.getState())).assistance.preferences.selectedMonsterIds)===notifications,'Analysis target changes never modify notification targets');
  await page.getByLabel('Analiz yaratığı').selectOption('1313');
  await page.getByRole('group',{name:'Analiz kapsamı'}).getByRole('button',{name:'Karakter',exact:true}).click();
  check(await page.getByRole('tab',{name:'Ritim',exact:true}).count()===0,'Unsupported character rhythm is not offered');
  await page.getByRole('tab',{name:'Eğilim',exact:true}).click();await page.getByLabel('Analiz referansı').selectOption('previous-day');
  await page.getByRole('group',{name:'Eğilim süresi'}).getByRole('button',{name:'7 gün',exact:true}).click();
  await page.getByRole('group',{name:'Grafik ölçümü'}).getByRole('button',{name:'Tempo',exact:true}).click();
  await page.keyboard.press('Escape');await sheet().waitFor({state:'hidden'});
  check(await page.getByRole('button',{name:'Analiz',exact:true}).evaluate(node=>node===document.activeElement),'Escape closes the sheet and returns focus');
  for(const theme of ['Siyah tema','Açık tema']){
    await page.getByRole('button',{name:theme,exact:true}).click();
    for(const width of [1480,1100,620]){
      await size(width,980);if(width===1480)await capture(`analytics-overview-${theme==='Siyah tema'?'dark':'light'}.png`);await openSheet();
      check(await sheet().evaluate(node=>{const r=node.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1&&node.scrollWidth<=node.clientWidth+1;}),`${theme} ${width}: sheet stays inside viewport without horizontal overflow`);
      await page.keyboard.press('Tab');check(await sheet().evaluate(node=>node.contains(document.activeElement)),`${theme} ${width}: keyboard remains within modal`);
      await capture(`analytics-${theme==='Siyah tema'?'dark':'light'}-${width}.png`);await closeSheet();
    }
  }
  await size(1480,980);
  check(await page.locator('.kill-table-scroll').evaluate(node=>{const r=node.getBoundingClientRect();return [...node.querySelectorAll('tr[data-kill-monster]')].filter(row=>{const q=row.getBoundingClientRect();return q.top>=r.top-1&&q.bottom<=r.bottom+1;}).length>=3;}),'Daily overview retains at least three complete monster rows');
  await app.evaluate(({ipcMain})=>{const handlers=ipcMain._invokeHandlers;globalThis.__qaOriginalAnalytics=handlers.get('midgard:hunt-analytics');ipcMain.removeHandler('midgard:hunt-analytics');ipcMain.handle('midgard:hunt-analytics',async(event,input)=>{if(input.reference==='previous-day')await new Promise(resolve=>setTimeout(resolve,450));if(input.monsterId===1391)throw new Error('SYNTHETIC analiz okuma hatası');return globalThis.__qaOriginalAnalytics(event,input);});});
  await openSheet();await page.getByLabel('Analiz referansı').selectOption('previous-7-days');await page.getByLabel('Analiz referansı').selectOption('previous-day');await page.getByLabel('Analiz referansı').selectOption('previous-7-days');await page.waitForTimeout(650);
  check(await page.getByLabel('Analiz referansı').inputValue()==='previous-7-days'&&(await sheet().innerText()).includes('Önceki 7 gün referansı'),'Slow old response never replaces the selected comparison');
  await page.getByLabel('Analiz yaratığı').selectOption('1391');await sheet().getByRole('alert').filter({hasText:'SYNTHETIC analiz okuma hatası'}).waitFor();
  check(await sheet().locator('.hunt-sheet-metrics').count()===0,'A read failure clears old metrics instead of showing another monster data');
  await page.getByLabel('Analiz yaratığı').selectOption('1313');await sheet().locator('.hunt-sheet-metrics').waitFor();
  await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('midgard:hunt-analytics');ipcMain.handle('midgard:hunt-analytics',globalThis.__qaOriginalAnalytics);delete globalThis.__qaOriginalAnalytics;});
  await closeSheet();
  const after=await page.evaluate(()=>window.midgard.getState());check(JSON.stringify(after.expansion.finance)===finance&&JSON.stringify(after.expansion.killCount.totals)===totals,'Analysis leaves finance and raw all-time kill totals untouched');
  const saved=await page.evaluate(()=>window.midgard.getHuntAnalyticsPreferences());await app.close();app=null;await launch();
  check(JSON.stringify(await page.evaluate(()=>window.midgard.getHuntAnalyticsPreferences()))===JSON.stringify(saved),'Independent analytics preferences survive a native app restart');
  await page.evaluate(async()=>{const prefs=await window.midgard.getHuntAnalyticsPreferences();await window.midgard.setHuntAnalyticsPreferences({...prefs,characterKey:null,scope:'character'});});
  await page.reload();await page.getByRole('button',{name:'Kill Count',exact:true}).click();await page.locator('[data-hunt-analytics]').waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-hunt-analytics]')?.textContent?.includes('Analiz için bir karakter seç.'));
  check((await page.locator('[data-analytics-metric="count"]').innerText())==='—','Several characters without a saved choice require an explicit character selection');
  await openSheet();await page.getByLabel('Analiz karakteri').selectOption(analyticsKeys[0]);await sheet().locator('.hunt-sheet-metrics').waitFor();check(true,'Choosing a character starts automatic analysis without a manual hunt session');await closeSheet();
  check(errors.length===0,'No renderer exceptions');
  const report={output,executable:process.argv[2]??'source electron .',passed:checks.length,checks,errors,screenshots,scope:'Synthetic archive in isolated profile only; no user profile or game client touched.'};await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await writeFile(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:String(error),stack:error.stack},null,2));try{await capture('failure.png');}catch{}throw error;}finally{await app?.close();}
