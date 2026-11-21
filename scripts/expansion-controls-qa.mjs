import {_electron as electron} from 'playwright';
import path from 'node:path';
import {mkdir,writeFile,open} from 'node:fs/promises';
import {assistanceReplay,baselinePackets,status} from './assistance-fixtures.mjs';
import {wait} from './qa-wait.mjs';

// Bounded controls regression: exclusively generated files and an isolated profile.
const output=path.resolve('.qa',`expansion-controls-${Date.now()}`),sources=path.join(output,'sources'),profile=path.join(output,'profile');
await mkdir(sources,{recursive:true});
const names=['QA Kontrol Çağrı','QA Kontrol İpek','QA Kontrol Özgür'],files=names.map((_,index)=>path.join(sources,`SYNTHETIC-controls-${index+1}.rrf`));
for(let index=0;index<3;index++)await writeFile(files[index],assistanceReplay({character:names[index],player:42+index}));
const env={...process.env,MIDGARD_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.MIDGARD_DEV_URL;
let app;const checks=[],errors=[];const assert=(condition,message)=>{if(!condition)throw Error(message);checks.push(message);};
const stateOf=page=>page.evaluate(()=>window.midgard.getState());
const openExpDetails=async card=>{const details=card.locator('.character-exp-details');if(!await details.evaluate(element=>element.open))await details.locator(':scope > summary').click();};
async function launch(){const value=await electron.launch({...(process.argv[2]?{executablePath:path.resolve(process.argv[2]),args:[]}:{args:['.']}),env,timeout:30000});const page=await value.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.waitForFunction(()=>!!window.midgard);await page.waitForSelector('h1');await page.evaluate(()=>{window.__qaLegacy=[];window.__qaExpanded=[];window.midgard.onNotification(value=>window.__qaLegacy.push(value));window.midgard.onExpansionNotification(value=>window.__qaExpanded.push(value));});return{app:value,page};}
const settle=page=>wait(page,async()=>{const state=await window.midgard.getState();return state.live.streams.length===3&&!state.live.activeWorkers&&!state.live.queuedCount&&state.live.streams.every(value=>value.summary&&value.status==='settled');},{},{timeout:30000});
async function grow(file,bytes){const handle=await open(file,'r+');try{await handle.write(bytes.subarray(352),0,bytes.length-352,352);await handle.write(bytes.subarray(0,352),0,352,0);await handle.sync();}finally{await handle.close();}}
try{
  let launched=await launch();app=launched.app;let page=launched.page;
  await app.evaluate(({dialog},filePaths)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths});},files);
  await page.getByRole('button',{name:'Dosya seç',exact:true}).first().click();await settle(page);
  let state=await stateOf(page);const a=state.live.streams.find(value=>value.character.name===names[0]),b=state.live.streams.find(value=>value.character.name===names[1]);
  let card=page.locator(`[data-stream-id="${a.id}"]`);
  assert(Object.keys(state.expansion.experience).length===3&&state.live.streams.length===3,'Three synthetic streams initialize independent EXP views');
  await openExpDetails(card);
  await card.locator('.expanded-exp-calibration summary').click();
  await card.getByRole('combobox',{name:'Meslek EXP tablosu',exact:true}).selectOption('second');
  await wait(page,async id=>(await window.midgard.getState()).expansion.experience[id].jobTrack==='second',a.id);
  assert(true,'GUI job-track selection stores Second Job for the chosen character');
  await card.getByRole('combobox',{name:'Kalibrasyon EXP türü',exact:true}).selectOption('job');await card.getByRole('combobox',{name:'Kalibrasyon biçimi',exact:true}).selectOption('current');
  await card.getByRole('spinbutton',{name:'Kalibrasyon seviyesi',exact:true}).fill('51');await card.getByRole('spinbutton',{name:'Başlangıç EXP değeri',exact:true}).fill('123');await card.getByRole('button',{name:'Başlangıcı uygula',exact:true}).click();
  await wait(page,async id=>{const value=(await window.midgard.getState()).expansion.experience[id].job;return value.level===51&&value.current===123&&value.status==='calibrated';},a.id);
  let job=(await stateOf(page)).expansion.experience[a.id].job;
  assert(job.required>1000&&job.requiredSource==='official-table'&&job.sourceUrl.includes('guide/21'),'Current-EXP calibration at Job 51 uses a sourced Second Job requirement');
  const required=job.required;
  await card.getByRole('combobox',{name:'Kalibrasyon biçimi',exact:true}).selectOption('percent');await card.getByRole('spinbutton',{name:'Başlangıç EXP değeri',exact:true}).fill('50');await card.getByRole('button',{name:'Başlangıcı uygula',exact:true}).click();
  await wait(page,async({id,expected})=>{const value=(await window.midgard.getState()).expansion.experience[id].job;return value.current===expected&&value.status==='calibrated';},{id:a.id,expected:Math.floor(required/2)});
  assert(true,'GUI percentage calibration calculates half of the level-51 requirement');
  await page.getByRole('button',{name:'Bildirim ayarları',exact:true}).click();await page.getByRole('combobox',{name:'Bildirim karakteri',exact:true}).selectOption(a.character.key);
  const preferences=page.locator('.character-alert-preferences');await preferences.getByRole('spinbutton',{name:'Karakter ağırlık eşiği',exact:true}).fill('66');
  await preferences.getByRole('checkbox',{name:/^Base EXP %90 oldu/}).check();await preferences.getByRole('checkbox',{name:/^Tahmini, kalibre edilmiş/}).check();await preferences.getByRole('button',{name:'Karakter ayarlarını uygula',exact:true}).click();
  await wait(page,async key=>{const value=(await window.midgard.getState()).expansion.alertPreferences[key];return value?.legacy.weightThreshold===66&&value.enabled['base-90']&&value.allowEstimated;},a.character.key);
  await page.getByRole('button',{name:/^Canlı takip/}).click();card=page.locator(`[data-stream-id="${a.id}"]`);const other=page.locator(`[data-stream-id="${b.id}"]`);await openExpDetails(card);
  assert((await card.locator('.assistant-weight-limit strong').innerText())==='%66'&&(await other.locator('.assistant-weight-limit strong').innerText())==='%65','Character A displays its 66% override while B retains the global 65% threshold');
  await page.waitForTimeout(1300);await page.evaluate(()=>{window.__qaLegacy=[];window.__qaExpanded=[];});
  await grow(files[0],assistanceReplay({character:names[0],packets:[...baselinePackets(),status(24,67000),status(1,4500)]}));
  await wait(page,({id,key})=>window.__qaLegacy.some(value=>value.streamId===id&&value.type==='weight')&&window.__qaExpanded.some(value=>value.characterKey===key&&value.type==='base-90'),{id:a.id,key:a.character.key});
  const notices=await page.evaluate(()=>({legacy:window.__qaLegacy,expanded:window.__qaExpanded}));
  assert(notices.legacy.filter(value=>value.type==='weight').length===1&&notices.legacy[0].message.includes('%66')&&notices.expanded.filter(value=>value.type==='base-90').length===1&&notices.expanded.every(value=>value.characterKey===a.character.key),'A new packet crossing emits its per-character weight alert and opted-in Base-90 notification');
  await page.waitForTimeout(2300);assert(await page.evaluate(()=>window.__qaLegacy.filter(value=>value.type==='weight').length===1&&window.__qaExpanded.filter(value=>value.type==='base-90').length===1),'Repeated signal ticks and snapshot polls do not duplicate either threshold notification');
  const beforePause=(await stateOf(page)).expansion.experience[a.id];await card.getByRole('button',{name:'Duraklat',exact:true}).click();
  await wait(page,async id=>(await window.midgard.getState()).live.streams.find(value=>value.id===id).status==='paused',a.id);
  await card.locator('.expanded-exp-calibration summary').click();await page.waitForFunction(id=>document.querySelector(`[data-stream-id="${id}"] select[aria-label="Meslek EXP tablosu"]`)?.disabled,a.id);
  state=await stateOf(page);const paused=state.expansion.experience[a.id];
  assert(paused.job.current===beforePause.job.current&&paused.job.level===beforePause.job.level&&paused.jobTrack==='second'&&await card.getByRole('button',{name:'Başlangıcı uygula',exact:true}).isDisabled(),'Pause preserves the last EXP snapshot and disables job-track and calibration submission controls');
  await card.getByRole('button',{name:'Devam et',exact:true}).click();await wait(page,async id=>{const value=(await window.midgard.getState()).expansion.experience[id];return value?.jobTrack==='second';},a.id);await settle(page);
  assert((await stateOf(page)).expansion.experience[a.id].jobTrack==='second','Resume restores the saved job track after safely baselining the current file');
  await page.screenshot({path:path.join(output,'controls-live.png'),fullPage:true});await app.close();app=null;
  launched=await launch();app=launched.app;page=launched.page;await settle(page);state=await stateOf(page);const restored=state.live.streams.find(value=>value.character.name===names[0]),config=state.expansion.alertPreferences[restored.character.key];
  assert(state.expansion.experience[restored.id].jobTrack==='second'&&config.legacy.weightThreshold===66&&config.enabled['base-90']&&config.allowEstimated&&!errors.length,'Restart preserves the job-track and per-character notification settings without renderer errors');
  const report={passed:checks.length,checks,errors,fixture:'Generated RRF packets only. No real gameplay copied.',limits:'Opt-in unverified EXP signals are tested; no claim of real Skadi event compatibility or physical speaker output.'};await writeFile(path.join(output,'expansion-controls-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));
}catch(error){await writeFile(path.join(output,'expansion-controls-failure.json'),JSON.stringify({checks,errors,failure:String(error)},null,2));try{await(await app?.firstWindow())?.screenshot({path:path.join(output,'failure.png'),fullPage:true});}catch{}throw error;}finally{await app?.close();}
