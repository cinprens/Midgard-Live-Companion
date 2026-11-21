import {_electron as electron} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import assert from 'node:assert/strict';
import {seedLiveAdventure,adventureNames,adventureKeys,adventureItems} from './live-adventure-fixtures.mjs';
import {cardReceived,status} from './assistance-fixtures.mjs';
import {wait} from './qa-wait.mjs';

// Generated Replays and this private profile only. No user profile/game files.
const output=path.resolve('.qa',`live-adventure-${Date.now()}`);await mkdir(output,{recursive:true});
const fixture=await seedLiveAdventure(output,{openStream:true}),executable=process.argv[2]?path.resolve(process.argv[2]):null;
// Model accumulated receipts from an earlier hunt in this isolated profile.
// A static Replay establishes the reader baseline and does not credit old loot.
const {ExpansionStore}=createRequire(import.meta.url)(path.join(output,'store.cjs'));
new ExpansionStore(fixture.database,{summaryOnly:true}).close();
const archive=new DatabaseSync(fixture.database);
try {
  const insert=archive.prepare('INSERT INTO compact_farm_totals(character_key,day,item_id,quantity,item_name) VALUES(?,?,?,?,?)');
  for(const [index,key] of adventureKeys.entries()){
    for(const item of adventureItems)insert.run(key,'2026-11-01',item.id,item.quantity+index,item.name);
  }
} finally {archive.close();}
const env={...process.env,MIDGARD_USER_DATA:fixture.profile};delete env.ELECTRON_RUN_AS_NODE;delete env.MIDGARD_DEV_URL;
const checks=[],errors=[],screenshots=[],geometry=[];let app,page,injection=false;
const startedAt=new Date().toISOString(),started=performance.now();
const check=(condition,label)=>{assert.ok(condition,label);checks.push(label);};
const state=()=>page.evaluate(()=>window.midgard.getState()),preferences=()=>page.evaluate(()=>window.midgard.getLiveView());
const card=index=>page.locator(`.live-character-row[data-live-character="${adventureKeys[index]}"]`),detail=()=>page.locator('.live-detail');
const appearance=index=>card(index).locator('[data-live-appearance]');
const trigger=index=>card(index).getByRole('button',{name:`${adventureNames[index]} görünümünü değiştir`,exact:true});
const dialog=index=>page.getByRole('dialog',{name:`${adventureNames[index]} için görünüm seç`,exact:true});
async function launch(){
  const args=executable?['--mute-audio']:['.','--mute-audio'];
  app=await electron.launch({...(executable&&{executablePath:executable}),args,env,timeout:30000});
  page=await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.locator('.live-workspace').waitFor({timeout:45000});

  // The first launch migrates legacy source preferences to their shared folder.
  // Restarts reopen the same folder and wait for each generated recording to grow.
  await wait(page,async count=>{
    const {discovery}= (await window.midgard.getState()).live;
    return discovery?.enabled&&discovery.candidateCount===count;
  },fixture.files.length);
  for(const [index,key] of adventureKeys.entries()){
    const time=fixture.entries[index].at(-1).time+1000;
    await fixture.append(index,[status(5,[4935,4840,4405][index])],time);
    await wait(page,async key=>(await window.midgard.getState()).live.streams.some(stream=>stream.character?.key===key&&stream.summary),key);
  }
  await wait(page,async()=>{
    const live=(await window.midgard.getState()).live;
    return live.streams.length===3&&live.streams.every(stream=>stream.summary&&['settled','following'].includes(stream.status))&&!live.activeWorkers&&!live.queuedCount;
  },null,{timeout:45000});
  await card(adventureKeys.length-1).waitFor();
}
async function select(index){await card(index).getByRole('button',{name:`${adventureNames[index]} ayrıntılarını aç`,exact:true}).click();await detail().waitFor();}
async function choose(index,id){await trigger(index).click();await dialog(index).waitFor();await dialog(index).locator(`[data-appearance-id="${id}"]`).click();await dialog(index).waitFor({state:'hidden'});await wait(page,async({key,id})=>(await window.midgard.getLiveView()).appearanceByCharacter[key]===id,{key:adventureKeys[index],id});await page.waitForFunction(({key,id})=>document.querySelector(`.live-character-row[data-live-character="${key}"] [data-live-appearance]`)?.getAttribute('data-live-appearance')===id,{key:adventureKeys[index],id});}
async function capture(name){await page.evaluate(()=>document.querySelectorAll('.assistant-flash button').forEach(button=>button.click()));await page.screenshot({path:path.join(output,name),fullPage:true});screenshots.push(name);}
async function theme(label){await page.getByRole('button',{name:`${label} tema`,exact:true}).click();await page.waitForFunction(value=>document.querySelector('.assistant-shell')?.getAttribute('data-theme')===value,label==='Siyah'?'dark':'light');await page.waitForTimeout(250);}
async function geometryCheck(label,desktop=true){
  const value=await page.evaluate(()=>{
    const rect=node=>{const r=node.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:node.clientWidth,scrollWidth:node.scrollWidth,height:node.clientHeight,scrollHeight:node.scrollHeight};};
    return{viewport:{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight},cards:[...document.querySelectorAll('.live-character-row')].map(node=>({...rect(node),body:rect(node.querySelector('.live-character-card-body')),scene:rect(node.querySelector('.live-character-scene'))})),detail:document.querySelector('.live-detail')?rect(document.querySelector('.live-detail')):null};
  });
  geometry.push({label,...value});check(value.viewport.scrollWidth<=value.viewport.width+1,`${label}: no horizontal document overflow`);
  if(desktop){
    const expectedCards=value.viewport.height<=760?1:3;
    check(value.viewport.scrollHeight<=value.viewport.height+1,`${label}: desktop document stays within the viewport`);
    check(value.cards.length===expectedCards&&value.cards.every(row=>row.bottom<=value.viewport.height+1&&row.right<=value.viewport.width+1&&row.scrollWidth<=row.width+1),`${label}: responsive character page stays visible and bounded`);
    check(value.cards.every(row=>row.scrollHeight<=row.height+1&&row.body.scrollHeight<=row.body.height+1&&row.body.bottom<=row.bottom+1&&row.body.right<=row.right+1),`${label}: card HP, weight and hourly details are not clipped inside their frames`);
    check(value.cards.every(row=>row.scene.height>=85),`${label}: character scene remains tall enough to display the selected artwork`);
  }
  if(value.detail&&desktop)check(value.detail.bottom<=value.viewport.height+1&&value.detail.scrollWidth<=value.detail.width+1,`${label}: selected character details stay within the viewport`);
}
async function inject(value){injection=true;await app.evaluate(({BaseWindow},value)=>{const wc=BaseWindow.getAllWindows()[0].contentView.children[0].webContents;wc.__adventureQaState=value;if(!wc.__adventureQaSend){wc.__adventureQaSend=wc.send;wc.send=function(channel,...args){return this.__adventureQaSend.call(this,channel,...(channel==='midgard:update'?[this.__adventureQaState]:args));};}wc.send('midgard:update',value);},value);}
async function restore(){if(!injection||!app)return;const actual=await state();await app.evaluate(({BaseWindow},actual)=>{const wc=BaseWindow.getAllWindows()[0].contentView.children[0].webContents;if(wc.__adventureQaSend){wc.send=wc.__adventureQaSend;delete wc.__adventureQaSend;delete wc.__adventureQaState;}wc.send('midgard:update',actual);},actual);injection=false;}
async function animations(index){return appearance(index).evaluate(node=>[...node.querySelectorAll('*')].map(child=>getComputedStyle(child).animationName).filter(name=>name&&name!=='none'));}

try{
  await launch();await page.getByRole('button',{name:`${adventureNames[0]} ayrıntılarını aç`,exact:true}).waitFor();
  const initial=await state(),legacy=await preferences(),finance=JSON.stringify(initial.expansion.finance),financeView=JSON.stringify(await page.evaluate(()=>window.midgard.getFinanceView())),killView=JSON.stringify(await page.evaluate(()=>window.midgard.getKillView())),targets=JSON.stringify(initial.assistance.preferences.selectedMonsterIds);
  check(JSON.stringify(legacy.appearanceByCharacter)==='{}'&&legacy.favoriteKeys.includes(adventureKeys[0]),'Legacy live settings gain an empty appearance map without losing favorites or selection');
  check(await page.locator('.live-character-row').count()===3&&await page.locator('.live-roster-table').count()===0,'The initial roster renders three scene cards rather than a data table');
  check(await page.locator('[data-live-highlight],[data-loot-highlight]').count()===0,'Initial historical replay loading does not invent fresh visual event cues');
  check((await state()).expansion.autoFarm.characters.every(character=>character.items.length===4),'The synthetic daily archive supplies four distinct accumulated item types for every character');
  await select(0);
  await trigger(0).click();await dialog(0).waitFor();
  check(await dialog(0).locator('[data-appearance-id^="feminine-"]').count()===4&&await dialog(0).locator('[data-appearance-id^="masculine-"]').count()===3,'The appearance picker offers exactly four feminine and three masculine choices');
  check((await dialog(0).innerText()).includes('temsili'),'The appearance picker explains that the art is cosmetic');
  await dialog(0).locator('[data-appearance-id^="feminine-"] img,[data-appearance-id^="masculine-"] img').evaluateAll(images=>Promise.all(images.map(img=>img.decode())));
  const thumbSources=await dialog(0).locator('[data-appearance-id^="feminine-"] img,[data-appearance-id^="masculine-"] img').evaluateAll(images=>images.map(img=>img.currentSrc));
  check(thumbSources.length===7&&new Set(thumbSources).size===7,'All seven distinct appearance thumbnail files load successfully');
  const sceneLoaded=await appearance(0).evaluate(async node=>{const match=/^url\(["']?(.*?)["']?\)$/.exec(getComputedStyle(node).backgroundImage);if(!match)return false;const image=new Image();image.src=match[1];await image.decode();return image.naturalWidth>0&&image.naturalHeight>0;});check(sceneLoaded,'The shared scene background loads and decodes from its bundled asset');
  check(await dialog(0).evaluate(node=>node.contains(document.activeElement)),'Opening appearance selection moves keyboard focus into the dialog');
  for(let index=0;index<12;index++){await page.keyboard.press('Tab');assert.ok(await dialog(0).evaluate(node=>node.contains(document.activeElement)),'Tab escaped the appearance dialog');}
  check(true,'Keyboard Tab remains trapped in the appearance dialog');
  await page.keyboard.press('Escape');await dialog(0).waitFor({state:'hidden'});
  check(await trigger(0).evaluate(node=>node===document.activeElement),'Escape closes the appearance picker and returns focus to its trigger');
  check(await detail().count()===1,'Closing the picker does not also dismiss the selected character details');
  for(const id of ['feminine-1','feminine-2','feminine-3','feminine-4','masculine-1','masculine-2','masculine-3']){await choose(0,id);await appearance(0).locator('img').evaluate(image=>image.decode());}
  check(true,'Every one of the seven choices updates and persists the selected character artwork');
  await choose(0,'feminine-4');await choose(1,'masculine-1');await select(0);
  const chosen=await preferences();check(chosen.appearanceByCharacter[adventureKeys[0]]==='feminine-4'&&chosen.appearanceByCharacter[adventureKeys[1]]==='masculine-1'&&!chosen.appearanceByCharacter[adventureKeys[2]],'Appearance choices are independent per character and do not infer the third character appearance');
  await choose(2,'masculine-3');
  const invalid=await page.evaluate(async()=>{const before=await window.midgard.getLiveView();let rejected=false;try{await window.midgard.setLiveView({...before,appearanceByCharacter:{...before.appearanceByCharacter,[before.characterKey]:'external-file'}});}catch{rejected=true;}return{rejected,unchanged:JSON.stringify(before)===JSON.stringify(await window.midgard.getLiveView())};});check(invalid.rejected&&invalid.unchanged,'Invalid appearance IDs are rejected without changing saved preferences');
  check(await page.locator('[data-loot-item-id]').count()===4,'The selected character loot strip renders at most four accumulated item tiles');
  for(const[id,kind]of [[4317,'card'],[480001,'costume'],[603,'generic'],[999999,'generic']])check(await page.locator(`[data-loot-item-id="${id}"]`).getAttribute('data-loot-kind')===kind,`Item ${id} uses the intended ${kind} category artwork`);
  const loot=await page.locator('[data-loot-item-id]').evaluateAll(nodes=>nodes.map(node=>({id:node.getAttribute('data-loot-item-id'),src:node.querySelector('img')?.currentSrc,loaded:!!node.querySelector('img')?.complete&&node.querySelector('img')?.naturalWidth>0,text:node.textContent})));
  check(loot.every(item=>item.loaded)&&loot.find(item=>item.id==='603').src===loot.find(item=>item.id==='999999').src&&new Set(loot.map(item=>item.src)).size===3,'Cards and costumes use distinct loaded art while Blue Box and other items share the same generic art');
  check(loot.find(item=>item.id==='4317').text.includes('2')&&loot.find(item=>item.id==='603').text.includes('3'),'Loot quantities belong to the selected character accumulated receipts');
  await select(1);await page.waitForFunction(()=>document.querySelector('[data-loot-item-id="4317"]')?.textContent?.includes('3'));check(true,'Selecting another character changes loot quantities to that character');await select(0);
  const first=initial.live.streams.find(stream=>stream.character.key===adventureKeys[0]);
  await detail().getByRole('button',{name:'Duraklat',exact:true}).click();await wait(page,async id=>(await window.midgard.getState()).live.streams.find(stream=>stream.id===id)?.status==='paused',first.id);await page.waitForTimeout(180);
  check((await animations(0)).length===0,'Paused sources stop cosmetic idle animation');
  await detail().getByRole('button',{name:'Devam et',exact:true}).click();await wait(page,async id=>['settled','following'].includes((await window.midgard.getState()).live.streams.find(stream=>stream.id===id)?.status),first.id);
  await page.emulateMedia({reducedMotion:'reduce'});check((await animations(0)).length===0,'Reduced motion disables cosmetic character animation');await page.emulateMedia({reducedMotion:'no-preference'});
  await fixture.append(0,[cardReceived(603,1,11),status(24,13000)],730000);
  await fixture.append(0,[status(5,4500)],731000);
  await wait(page,async key=>(await window.midgard.getState()).expansion.autoFarm.characters.find(character=>character.characterKey===key)?.items.find(item=>item.itemId===603)?.quantity===4,adventureKeys[0]);await page.waitForFunction(()=>document.querySelector('[data-loot-item-id="603"]')?.textContent?.includes('4'));
  check((await preferences()).appearanceByCharacter[adventureKeys[0]]==='feminine-4','Genuine synthetic replay updates refresh loot without resetting cosmetic choices');
  await page.waitForFunction(key=>!!document.querySelector(`.live-character-row[data-live-character="${key}"]`)?.getAttribute('data-live-highlight')&&!!document.querySelector('[data-loot-item-id="603"]')?.getAttribute('data-loot-highlight'),adventureKeys[0]);
  const cue=await card(0).getAttribute('data-live-highlight');check(!!cue&&await page.locator('[data-loot-item-id="603"]').getAttribute('data-loot-highlight')===cue&&await card(1).getAttribute('data-live-highlight')===null&&await card(2).getAttribute('data-live-highlight')===null,'A genuine new Blue Box notification highlights only its character and matching loot tile');
  check(await page.locator('[data-loot-highlight]').count()===1,'The new item notification leaves unrelated loot tiles unhighlighted');
  await page.emulateMedia({reducedMotion:'reduce'});check(await page.locator('.live-card-event,.live-loot-event').evaluateAll(nodes=>nodes.length>=2&&nodes.every(node=>getComputedStyle(node).animationName==='none')),'Reduced motion keeps a static event cue without running its animation');await page.emulateMedia({reducedMotion:'no-preference'});
  await page.waitForFunction(()=>document.querySelectorAll('[data-live-highlight],[data-loot-highlight]').length===0);check(true,'Transient character and item cues expire automatically rather than becoming a permanent glow');
  const liveNow=await state(),stale=structuredClone(liveNow),staleFirst=stale.live.streams.find(stream=>stream.id===first.id);staleFirst.status='error';staleFirst.lastSuccessfulReadAt='2026-11-01T00:00:00Z';staleFirst.diagnostics=['SYNTHETIC UI-only stale-source rendering fixture.'];await inject(stale);await page.waitForFunction(()=>document.querySelector('.live-workspace')?.getAttribute('data-live-read-health')==='partial');
  check((await card(0).innerText()).includes('Okuma durdu')&&(await animations(0)).length===0,'A failed reader keeps its last known card values but stops the scene and labels the failure');
  check((await detail().innerText()).includes('Son doğru özet'),'Selected failed-source details show data freshness and incomplete coverage');
  const allBlocked=structuredClone(stale);for(const stream of allBlocked.live.streams)stream.status='error';await inject(allBlocked);await page.waitForFunction(()=>document.querySelector('.live-workspace')?.getAttribute('data-live-read-health')==='stopped');check((await page.locator('.live-heading').innerText()).includes('Kayıtlar okunamıyor'),'When all readers fail the whole live screen makes the stopped state explicit');await restore();
  for(const[width,height]of [[1480,1000],[1100,820],[1100,720],[620,900]]){
    await app.evaluate(({BaseWindow},[w,h])=>{const win=BaseWindow.getAllWindows()[0];win.setMinimumSize(400,500);win.setSize(w,h);},[width,height]);
    for(const label of ['Siyah','Açık']){await theme(label);await geometryCheck(`${label} ${width}x${height}`,width>=1100);await capture(`live-adventure-${label==='Siyah'?'dark':'light'}-${width}x${height}.png`);}
    if(width===1100&&height===720){
      for(const index of [1,2]){await page.getByRole('button',{name:'Sonraki karakter sayfası',exact:true}).click();await card(index).waitFor();await geometryCheck(`Short viewport character page ${index+1}`);}
      await page.getByRole('button',{name:'Önceki karakter sayfası',exact:true}).click();await page.getByRole('button',{name:'Önceki karakter sayfası',exact:true}).click();await card(0).waitFor();
      check((await preferences()).characterKey===adventureKeys[0],'Short-window pagination reaches every character without silently changing the selected detail scope');
    }
  }
  await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows()[0].setSize(1480,1000));await theme('Siyah');await trigger(0).click();await capture('live-adventure-appearance-picker.png');await page.keyboard.press('Escape');
  await app.evaluate(({BaseWindow},{streamId,character})=>{const wc=BaseWindow.getAllWindows()[0].contentView.children[0].webContents;wc.send('midgard:notification',{id:'synthetic-wrong-stream-cue',type:'old-blue-box',streamId:'synthetic-unrelated-source',character,at:new Date().toISOString(),message:'SYNTHETIC wrong-stream cue',itemId:603,amount:1});wc.send('midgard:notification',{id:'synthetic-expired-cue',type:'old-blue-box',streamId,character,at:new Date(Date.now()-10000).toISOString(),message:'SYNTHETIC expired cue',itemId:603,amount:1});},{streamId:first.id,character:adventureNames[0]});
  await page.waitForFunction(()=>document.querySelector('.live-alerts')?.textContent?.includes('SYNTHETIC expired cue')&&document.querySelector('.live-alerts')?.textContent?.includes('SYNTHETIC wrong-stream cue'));check(await page.locator('[data-live-highlight],[data-loot-highlight]').count()===0,'Expired notices and another source with the same character label cannot highlight current cards or loot');
  const after=await state();check(JSON.stringify(after.expansion.finance)===finance&&JSON.stringify(await page.evaluate(()=>window.midgard.getFinanceView()))===financeView&&JSON.stringify(await page.evaluate(()=>window.midgard.getKillView()))===killView,'The adventure UI preserves existing finance ledger and Finance/Kill Count preferences');
  check(JSON.stringify(after.assistance.preferences.selectedMonsterIds)===targets,'Appearance and loot controls preserve notification target preferences');
  check(after.expansion.killCount.totals.observedDeaths===initial.expansion.killCount.totals.observedDeaths&&after.expansion.autoFarm.totals.quantity===initial.expansion.autoFarm.totals.quantity+1,'Visual interactions do not change raw death observations or accumulated receipt quantities');
  check((await page.evaluate(()=>window.midgard.getFinanceView())).scopeMode==='daily','The navigation regression starts with Finance previously left in daily mode');
  await page.getByRole('button',{name:'Seçili karakterin tüm eşyalarını Finans’ta aç',exact:true}).click();await page.locator('.finance-workspace').waitFor();
  const linkedFinance=await page.evaluate(()=>window.midgard.getFinanceView());check(linkedFinance.characterKey===adventureKeys[0]&&linkedFinance.scopeMode==='all'&&linkedFinance.tab==='all'&&await page.getByRole('combobox',{name:'Karakter seç',exact:true}).inputValue()===adventureKeys[0],'The accumulated-gains link opens all-time Finance for the selected character even after a daily view');
  check(linkedFinance.favoriteIds.includes(603)&&linkedFinance.hiddenIds.includes(746)&&linkedFinance.sort==='name-asc'&&linkedFinance.pageSize===100&&linkedFinance.dailyDate==='2026-11-04','All-time Finance navigation preserves favorites, hidden items, sorting and the remembered daily date');
  await page.getByRole('navigation',{name:'Ana gezinme'}).getByRole('button',{name:/^Canlı takip/}).click();await page.locator('.live-workspace').waitFor();await page.evaluate(value=>window.midgard.setFinanceView(value),JSON.parse(financeView));
  const saved=await preferences(),beforeRestart=await state();await app.close();app=null;await launch();await detail().waitFor();
  check(JSON.stringify(await preferences())===JSON.stringify(saved),'Appearance choices, legacy favorites and selected character survive native restart');
  check(await appearance(0).getAttribute('data-live-appearance')==='feminine-4'&&await appearance(1).getAttribute('data-live-appearance')==='masculine-1','Restart restores the independently selected scene artworks');
  check((await state()).expansion.autoFarm.totals.quantity===beforeRestart.expansion.autoFarm.totals.quantity&&(await state()).expansion.killCount.totals.observedDeaths===beforeRestart.expansion.killCount.totals.observedDeaths,'Restart does not recount replay receipts or death observations');
  check(errors.length===0,'No renderer errors');
  await app.close();app=null;const db=new DatabaseSync(fixture.database,{readOnly:true});try{check(db.prepare('PRAGMA quick_check').get()?.quick_check==='ok'&&db.prepare('PRAGMA foreign_key_check').all().length===0,'The private profile passes SQLite integrity and foreign-key checks after shutdown');}finally{db.close();}
  const report={output,startedAt,completedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-started),executable:executable??'source electron .',passed:checks.length,checks,rendererErrors:errors,screenshots,geometry,scope:'Generated RRF files, catalog and historical daily item totals in a private profile. The new Blue Box uses a live Replay pickup and a matching weight increase. The stale-source and expired/unrelated notification scenarios inject renderer-only payloads. Folder discovery, pause/resume and restart use the application normally.'};await writeFile(path.join(output,'live-adventure-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,passed:checks.length,rendererErrors:errors.length,durationMs:report.durationMs,screenshots:screenshots.length},null,2));
}catch(error){await writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,checks,errors,geometry},null,2));try{await capture('failure.png');}catch{}throw error;}
finally{await restore().catch(()=>{});await app?.close();}
