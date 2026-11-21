import {_electron as electron} from 'playwright';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import assert from 'node:assert/strict';
import {seedLiveAdventure,adventureNames,adventureKeys,adventurePlayers} from './live-adventure-fixtures.mjs';
import {mobDeath,monsterSpawn,damage,vanish} from './kill-count-fixtures.mjs';
import {ownDeath,status} from './assistance-fixtures.mjs';
import {wait} from './qa-wait.mjs';

// Only generated Replays and a fresh private profile. No game or real profile access.
const output=path.resolve('.qa',`solo-experience-${Date.now()}`);await mkdir(output,{recursive:true});
const fixture=await seedLiveAdventure(output,{experience:true,openStream:true}),executable=process.argv[2]?path.resolve(process.argv[2]):null;
const env={...process.env,MIDGARD_USER_DATA:fixture.profile};delete env.ELECTRON_RUN_AS_NODE;delete env.MIDGARD_DEV_URL;
const checks=[],errors=[],screenshots=[],geometry=[];let app,page,missingFile=null;
const startedAt=new Date().toISOString(),started=performance.now();
const check=(condition,label)=>{assert.ok(condition,label);checks.push(label);};
const state=()=>page.evaluate(()=>window.midgard.getState());
const daily=(scopeMode='daily',date='2026-11-01')=>page.evaluate(query=>window.midgard.getSoloExperienceDaily(query),{scopeMode,date});
const entries=value=>adventureKeys.map(key=>value.expansion.killExperience.characters.find(c=>c.characterKey===key));
const sessions=value=>entries(value).map(c=>c?.session);
const soloCard=index=>page.getByRole('article',{name:`${adventureNames[index]} EXP kazanımı`,exact:true});
const liveCard=index=>page.locator(`.live-character-row[data-live-character="${adventureKeys[index]}"]`);
const near=(actual,expected)=>typeof actual==='number'&&Math.abs(actual-expected)<=Math.max(1e-7,Math.abs(expected)*1e-10);
async function launch(){
  const args=['--mute-audio','--replace-live-sources',...fixture.files.map(file=>'--live-file='+file)];
  app=await electron.launch({...(executable?{executablePath:executable,args}:{args:['.',...args]}),env,timeout:30000});
  page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  await page.locator('.assistant-shell').waitFor({timeout:45000});
  await wait(page,async()=>{const v=await window.midgard.getState();return v.live.streams.length===3&&v.live.streams.every(s=>s.summary&&['settled','following'].includes(s.status))&&!v.live.activeWorkers&&!v.live.queuedCount;},null,{timeout:45000});
}
async function goExperience(){
  await page.getByRole('navigation',{name:'Ana gezinme'}).getByRole('button',{name:'EXP Kazanımı',exact:true}).click();
  await page.getByRole('button',{name:'Solo tahmini',exact:true}).click();
  await page.getByRole('group',{name:'EXP dönemi',exact:true}).getByRole('button',{name:'Tümü',exact:true}).click();
  await page.locator('.solo-exp-history[data-solo-period="all"][aria-busy="false"]').waitFor();
}
async function goLive(){await page.getByRole('navigation',{name:'Ana gezinme'}).getByRole('button',{name:/^Canlı takip/}).click();await page.locator('.live-workspace').waitFor();if(await page.evaluate(()=>innerWidth<=650)){const close=page.getByRole('button',{name:'Karakter ayrıntılarını kapat',exact:true});if(await close.isVisible())await close.click();await page.locator('.live-character-row').first().waitFor({state:'visible'});await page.locator('.live-character-row').first().scrollIntoViewIfNeeded();}}
async function select(index){await page.getByRole('combobox',{name:'EXP karakteri',exact:true}).selectOption(adventureKeys[index]);await page.waitForFunction(key=>document.querySelector('select[aria-label="EXP karakteri"]')?.value===key,adventureKeys[index]);}
async function apiRate(index,baseExp,jobExp,monsterId=1313){await page.evaluate(input=>window.midgard.setKillExperienceRate(input),{characterKey:adventureKeys[index],monsterId,baseExp,jobExp});}
async function apiControl(index,action){await page.evaluate(async({key,action})=>{const s=await window.midgard.getState(),c=s.expansion.killExperience.characters.find(c=>c.characterKey===key),source=s.expansion.killExperience.sources.find(x=>x.characterKey===key);return window.midgard.controlKillExperience({characterKey:key,streamId:source.streamId,recordingId:source.recordingId,action,...(c?.session?{sessionId:c.session.id}:{})});},{key:adventureKeys[index],action});}
async function waitSession(index,expected){await wait(page,async({key,expected})=>{const value=(await window.midgard.getState()).expansion.killExperience.characters.find(c=>c.characterKey===key)?.session;return value&&Object.entries(expected).every(([k,v])=>value[k]===v);},{key:adventureKeys[index],expected});}
async function append(index,packets,time){await fixture.append(index,packets,time);await wait(page,async({key,count})=>{const v=await window.midgard.getState(),s=v.live.streams.find(s=>s.character?.key===key);return s?.packetCount===count&&!v.live.activeWorkers&&!v.live.queuedCount;},{key:adventureKeys[index],count:fixture.entries[index].length},{timeout:45000});}
async function capture(name){await page.evaluate(()=>document.querySelectorAll('.assistant-flash button').forEach(b=>b.click()));await page.screenshot({path:path.join(output,name),fullPage:true});screenshots.push(name);}
async function theme(label){await page.getByRole('button',{name:`${label} tema`,exact:true}).click();await page.waitForFunction(value=>document.querySelector('.assistant-shell')?.getAttribute('data-theme')===value,label==='Siyah'?'dark':'light');await page.waitForTimeout(150);}
async function geometryCheck(label,view){
  const data=await page.evaluate(view=>{
    const rect=n=>{const r=n.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:n.clientWidth,scrollWidth:n.scrollWidth,height:n.clientHeight,scrollHeight:n.scrollHeight};};
    const cards=[...document.querySelectorAll(view==='live'?'.live-character-row':'.solo-exp-character')];
    const measuredCards=cards.map(node=>{
      if(view!=='live')return rect(node);
      const scene=node.querySelector('.live-character-scene'),image=scene.querySelector('img');
      // Both sprite slots use object-fit:contain; the crest's taller slot includes transparent margins.
      const box=image.getBoundingClientRect(),scale=Math.min(box.width/image.naturalWidth,box.height/image.naturalHeight);
      const width=image.naturalWidth*scale,height=image.naturalHeight*scale;
      const [alignX,alignY]=getComputedStyle(image).objectPosition.split(' ').map(value=>parseFloat(value)/100);
      const left=box.left+(box.width-width)*alignX,top=box.top+(box.height-height)*alignY;
      return {...rect(node),body:rect(node.querySelector('.live-character-card-body')),scene:rect(scene),
        artwork:{width,height,left,top,right:left+width,bottom:top+height,loaded:image.complete&&image.naturalWidth>0}};
    });
    return{width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,cards:measuredCards,tracks:[...document.querySelectorAll('.solo-exp-track')].map(rect),bars:[...document.querySelectorAll('.solo-exp-gain-bar')].map(n=>({outer:rect(n),inner:rect(n.firstElementChild)}))};
  },view);geometry.push({label,view,...data});
  check(data.documentWidth<=data.width+1,`${label}: no horizontal document overflow`);
  check(data.cards.length>0&&data.cards.every(c=>c.scrollWidth<=c.width+1&&c.right<=data.width+1),`${label}: EXP cards fit horizontally`);
  check(data.tracks.every(t=>t.scrollWidth<=t.width+1),`${label}: EXP labels and values are not clipped horizontally`);
  if(view==='live'){
    const expected=data.width<=650||data.height<=760?1:3;
    check(data.cards.length===expected,`${label}: live pagination renders ${expected} visible character cards`);
    check(data.cards.every(c=>c.scrollHeight<=c.height+1&&c.bottom<=data.height+1&&c.body.scrollHeight<=c.body.height+1&&c.body.bottom<=c.bottom+1&&c.body.right<=c.right+1),`${label}: live card contents fit their frames`);
    check(data.cards.every(({scene,artwork})=>artwork.loaded&&artwork.height>0&&artwork.width>0&&
      artwork.top>=scene.top-1&&artwork.bottom<=scene.bottom+1&&artwork.left>=scene.left-1&&artwork.right<=scene.right+1),
      `${label}: character sprite or crest loads and fits inside its live scene with EXP visible`);
    check(data.bars.length===expected*2&&data.bars.every(b=>b.inner.width<=b.outer.width+1),`${label}: two gain bars per character stay within their tracks`);
  }
}

try{
  await launch();
  const initial=await state();
  check(initial.live.streams.every(s=>s.summary.liveTelemetry.baseLevel===10&&s.summary.liveTelemetry.jobLevel===5),'Generated replay metadata supplies Base 10 and Job 5');
  await page.evaluate(async({keys})=>{const current=await window.midgard.getLiveView();return window.midgard.setLiveView({...current,appearanceByCharacter:{...current.appearanceByCharacter,[keys[0]]:'feminine-4',[keys[1]]:'masculine-1'}});},{keys:adventureKeys});
  const saved={finance:JSON.stringify(initial.expansion.finance),financeView:JSON.stringify(await page.evaluate(()=>window.midgard.getFinanceView())),killView:JSON.stringify(await page.evaluate(()=>window.midgard.getKillView())),alerts:JSON.stringify(initial.assistance.preferences),live:await page.evaluate(()=>window.midgard.getLiveView())};
  await goExperience();
  check(await page.locator('.solo-exp-character').count()===3,'The EXP tab compares three independent character cards');
  check(await page.locator('.solo-exp-information').count()===0,'Detailed solo/party limitations are collapsed initially');
  check((await page.locator('.solo-exp-heading').innerText()).includes('tahmini solo EXP'), 'The header labels the optional solo estimate');
  const info=page.getByRole('button',{name:'EXP hesaplama bilgisi',exact:true});await info.click();
  check(await info.getAttribute('aria-expanded')==='true'&&(await page.locator('.solo-exp-information').innerText()).includes('Party ile çalışmaz'),'Accessible information toggle explains that party use is unsupported');
  await info.click();check(await info.getAttribute('aria-expanded')==='false'&&await page.locator('.solo-exp-information').count()===0,'Information details close through their toggle');
  const labels=await page.locator('.solo-exp-workspace input,.solo-exp-workspace select').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')??''));
  check(!labels.some(label=>/yüzde|başlangıç|seviye|kayıp|ceza/i.test(label)),'No manual current percentage, starting level or death penalty input is requested');
  await select(0);await page.getByRole('textbox',{name:'Yaratık kimliği',exact:true}).fill('1313');
  await page.getByRole('textbox',{name:'Yaratık Base EXP',exact:true}).fill('1000');await page.getByRole('textbox',{name:'Yaratık Job EXP',exact:true}).fill('100');
  await page.getByRole('button',{name:'EXP değerlerini kaydet',exact:true}).click();
  await wait(page,async key=>(await window.midgard.getState()).expansion.killExperience.characters.find(c=>c.characterKey===key)?.rates.find(r=>r.monsterId===1313)?.baseExp===1000,adventureKeys[0]);
  await page.getByRole('button',{name:'Solo ölçümü başlat',exact:true}).click();await waitSession(0,{status:'running',observedDeaths:0});
  for(const index of [1,2]){await apiRate(index,(index+1)*1000,(index+1)*100);await apiControl(index,'start');await waitSession(index,{status:'running',observedDeaths:0});}
  let value=await state();
  check(sessions(value).every(s=>s.base.gained===0&&s.job.gained===0&&s.mode==='single'),'A real UI start plus two API starts exclude historical deaths for all three characters');
  check(sessions(value).every(s=>s.soloReference?.baseLevel===10&&s.soloReference.jobLevel===5&&s.soloReference.jobTrack==='first'&&s.soloProgress.base.requiredExp===12400&&s.soloProgress.job.requiredExp===1250),'Each start freezes its automatically observed levels and existing Skadi table requirements');
  for(let index=0;index<3;index++)await append(index,Array.from({length:index+1},(_,n)=>mobDeath(20000+index*100+n,1313,'Mobster',adventurePlayers[index])).flat(),730000);
  for(let index=0;index<3;index++)await waitSession(index,{observedDeaths:index+1});
  value=await state();check(sessions(value).every((s,i)=>s.base.gained===(i+1)**2*1000&&s.job.gained===(i+1)**2*100),'Three independent Replay appends apply each character own entered EXP rate');
  check(sessions(value).every(s=>s.attributionPolicy==='own-damage-v1'),'Every new solo measurement persists its own-damage counting policy');
  await append(0,[...mobDeath(29990,1313,'Other attacker',999),monsterSpawn(29991,1313,'Mixed attackers'),damage(42,29991),damage(999,29991),vanish(29991),monsterSpawn(29992,1313,'Unattributed death'),vanish(29992)],730000);
  value=await state();check(sessions(value)[0].observedDeaths===1&&sessions(value)[0].base.gained===1000&&sessions(value)[0].job.gained===100,'Other attackers, mixed attackers and deaths without observed damage do not award solo EXP');
  check(sessions(value).every(s=>near(s.soloProgress.base.percent,s.base.gained/12400*100)&&near(s.soloProgress.base.perHour,s.base.gained/(s.durationMs/3600000))),'Percent-equivalent and gross hourly values use the frozen denominator and observed session duration');
  const beforeRepeat=sessions(value).map(s=>({id:s.id,deaths:s.observedDeaths,base:s.base.gained,job:s.job.gained}));
  await page.waitForTimeout(5600);value=await state();
  check(sessions(value).every((s,i)=>s.id===beforeRepeat[i].id&&s.observedDeaths===beforeRepeat[i].deaths&&s.base.gained===beforeRepeat[i].base),'Normal duplicate refresh does not count historical deaths again');
  await apiRate(0,999,99,1002);await append(0,mobDeath(20100,1002,'Unselected QA Monster',42),760000);
  check(sessions(await state())[0].observedDeaths===1&&sessions(await state())[0].base.gained===1000,'A target added after start remains outside the frozen session target set');
  await apiRate(0,20000,100);check(sessions(await state())[0].base.gained===1000,'Editing a target rate leaves already counted EXP unchanged');
  await append(0,mobDeath(20101,1313,'Mobster',42),790000);await waitSession(0,{observedDeaths:2});
  value=await state();check(sessions(value)[0].base.gained===21000&&sessions(value)[0].soloProgress.base.percent>100,'Only future deaths use the edited rate; gain-equivalent can exceed 100 percent');
  await page.waitForFunction(()=>document.querySelector('.solo-exp-current-tracks [data-solo-percent="base"]')?.textContent?.includes('+%169,35'));
  check((await page.locator('.solo-exp-current-tracks [data-solo-percent="base"]').innerText()).includes('+%169,35'),'The current-session numeric percentage-equivalent remains visible above 100 percent');
  await append(0,[ownDeath(42)],820000);
  check(sessions(await state())[0].base.gained===21000&&sessions(await state())[0].soloProgress.base.status==='estimated','An owner death does not reduce gross EXP or request percentage recalibration');
  await select(0);await page.locator('.solo-exp-controls').getByRole('button',{name:'Duraklat',exact:true}).click();await waitSession(0,{status:'paused'});
  const paused=sessions(await state())[0];await append(0,mobDeath(20102,1313,'Mobster',42),850000);
  check(sessions(await state())[0].observedDeaths===2&&sessions(await state())[0].durationMs===paused.durationMs,'Paused deaths and paused duration do not contribute');
  await page.locator('.solo-exp-controls').getByRole('button',{name:'Devam et',exact:true}).click();await waitSession(0,{status:'running',observedDeaths:2});
  await append(0,mobDeath(20103,1313,'Mobster',42),880000);await waitSession(0,{observedDeaths:3});
  check(sessions(await state())[0].base.gained===41000,'Resume counts only the next fresh death and keeps the existing reference');
  await apiRate(1,2000,null);await append(1,mobDeath(20200,1313,'Mobster',43),900000);await waitSession(1,{observedDeaths:3});
  value=await state();check(sessions(value)[1].base.gained===6000&&sessions(value)[1].job.gained===null&&sessions(value)[1].job.knownGained===400&&sessions(value)[1].soloProgress.job.percent===null,'A blank Job rate makes only Job incomplete and preserves its known subtotal');
  await page.waitForFunction(name=>[...document.querySelectorAll('.solo-exp-character')].find(n=>n.getAttribute('aria-label')===name)?.textContent?.includes('Kısmi'),`${adventureNames[1]} EXP kazanımı`);
  check((await soloCard(1).innerText()).includes('Kısmi')&&(await soloCard(1).locator('[data-solo-gained="job"]').innerText()).includes('400'),'The incomplete channel is visibly labeled with its known subtotal');
  await apiRate(2,0,0);await append(2,mobDeath(20300,1313,'Mobster',44),900000);await waitSession(2,{observedDeaths:4});
  check(sessions(await state())[2].base.gained===9000&&sessions(await state())[2].soloProgress.base.status==='estimated','Explicit zero EXP remains a known value rather than an unknown rate');
  await append(0,[status(11,11),status(55,6)],910000);
  check(sessions(await state())[0].soloReference.baseLevel===10&&sessions(await state())[0].soloProgress.base.requiredExp===12400,'Later observed level changes do not silently change the percentage denominator');
  await select(0);await page.getByRole('textbox',{name:'Yaratık Base EXP',exact:true}).fill('-1');await page.getByRole('button',{name:'EXP değerlerini kaydet',exact:true}).click();
  await page.locator('.solo-exp-error[role="alert"]').waitFor();check((await page.locator('.solo-exp-error').innerText()).includes('pozitif'),'Invalid user rate produces a visible error');
  await page.getByRole('textbox',{name:'Yaratık Base EXP',exact:true}).fill('20000');
  await select(2);const moved=fixture.files[2]+'.temporarily-missing';assert.ok(moved.startsWith(output+path.sep));await rename(fixture.files[2],moved);missingFile={from:moved,to:fixture.files[2]};
  await waitSession(2,{status:'source-unavailable'});await page.locator('.solo-exp-session .solo-exp-notice').waitFor();
  check((await page.locator('.solo-exp-session').innerText()).includes('Kaynak bekleniyor'),'A genuinely unavailable private Replay source is visible in the EXP page');
  await rename(moved,fixture.files[2]);missingFile=null;await waitSession(2,{status:'running'});
  check(sessions(await state())[2].observedDeaths===4&&sessions(await state())[2].base.gained===9000,'The same verified Replay snapshot recovers automatically without inventing a gap award');
  await append(2,[status(5,4405)],930000);await waitSession(2,{status:'running'});
  await append(2,mobDeath(20350,1313,'Mobster',adventurePlayers[2]),940000);await waitSession(2,{observedDeaths:5});
  check(sessions(await state())[2].base.gained===9000,'Only a fresh post-recovery death advances the counter and respects its explicit zero EXP rate');
  const beforeRestart=await state(),persisted=sessions(beforeRestart).map(s=>({id:s.id,status:s.status,deaths:s.observedDeaths,base:s.base.gained,job:s.job.gained,knownJob:s.job.knownGained,reference:s.soloReference})),savedRates=JSON.stringify(entries(beforeRestart).map(c=>c.rates));
  check(Object.keys(beforeRestart.expansion.experience??{}).length===0&&beforeRestart.live.streams.every(s=>{const original=initial.live.streams.find(item=>item.character.key===s.character.key)?.summary.liveTelemetry;return original&&['currentBaseExp','currentJobExp','baseExpGained','jobExpGained','nextBaseExp','nextJobExp'].every(key=>s.summary.liveTelemetry[key]===original[key]);}),'Estimated gains do not enable measured EXP features or change actual fixture telemetry values');
  await app.close();app=null;await launch();await goExperience();value=await state();
  check(sessions(value).every((s,i)=>s.id===persisted[i].id&&s.status===persisted[i].status&&s.streamId===value.live.streams.find(stream=>stream.character?.key===s.characterKey)?.id&&s.observedDeaths===persisted[i].deaths&&s.base.gained===persisted[i].base&&s.job.gained===persisted[i].job&&s.job.knownGained===persisted[i].knownJob&&JSON.stringify(s.soloReference)===JSON.stringify(persisted[i].reference))&&JSON.stringify(entries(value).map(c=>c.rates))===savedRates,'Native restart preserves running sessions, rates, partial subtotals and starting references on current stream identities without recounting history');
  await append(0,mobDeath(20400,1313,'Mobster',42),940000);await waitSession(0,{observedDeaths:4});
  check(sessions(await state())[0].base.gained===61000,'Restored measurement continues only with fresh post-restart Replay events');
  for(const [width,height]of [[1480,1000],[1100,820],[620,900]]){
    await app.evaluate(({BaseWindow},[w,h])=>{const win=BaseWindow.getAllWindows()[0];win.setMinimumSize(400,500);win.setSize(w,h);},[width,height]);
    for(const label of ['Siyah','Açık']){
      await theme(label);await goExperience();await geometryCheck(`${label} ${width}x${height} EXP`,'experience');await capture(`exp-${label==='Siyah'?'dark':'light'}-${width}x${height}.png`);
      await goLive();await geometryCheck(`${label} ${width}x${height} live`,'live');await capture(`live-${label==='Siyah'?'dark':'light'}-${width}x${height}.png`);
    }
    if(width===620){for(const index of [1,2]){await page.getByRole('button',{name:'Sonraki karakter sayfası',exact:true}).click();await liveCard(index).waitFor();check(await liveCard(index).locator('.solo-exp-compact').count()===1,`Narrow live pagination exposes character ${index+1} EXP`);}for(let i=0;i<2;i++)await page.getByRole('button',{name:'Önceki karakter sayfası',exact:true}).click();}
  }
  await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows()[0].setSize(1480,1000));await theme('Siyah');await goLive();
  const firstBar=liveCard(0).locator('[data-solo-track="base"] .solo-exp-gain-bar>i');
  check(await firstBar.evaluate(n=>n.style.width)==='100%'&&(await liveCard(0).locator('[data-solo-percent="base"]').innerText()).includes('+%491,94'),'Compact gain bar clamps its width while the numeric equivalent stays above 100 percent');
  await liveCard(0).getByRole('button',{name:`${adventureNames[0]} EXP Kazanımı aç`,exact:true}).click();await page.locator('.solo-exp-workspace').waitFor();
  check(await page.getByRole('combobox',{name:'EXP karakteri',exact:true}).inputValue()===adventureKeys[0],'The compact EXP shortcut selects its own character in the full tab');
  const archived=await daily(),allArchived=await daily('all'),emptyDay=await daily('daily','2026-11-02');
  const periodCharacter=(period,index)=>period.characters.find(c=>c.characterKey===adventureKeys[index])?.totals;
  check(archived.timeZone==='Europe/Istanbul'&&archived.totals.base.knownGained===76000&&allArchived.totals.base.knownGained===76000&&archived.undatedObservedDeaths===0,'Dated and all-time archives include the expected 76,000 known Base EXP on the fixture Istanbul day');
  check(periodCharacter(archived,0)?.base.gained===61000&&periodCharacter(archived,1)?.base.gained===6000&&periodCharacter(archived,2)?.base.gained===9000,'Daily archives retain each character independent gains');
  check(periodCharacter(archived,1)?.job.gained===null&&periodCharacter(archived,1)?.job.knownGained===400,'Daily archive preserves an incomplete Job channel rather than treating it as zero');
  check(!emptyDay.totals.hasData&&emptyDay.totals.base.knownGained===0&&emptyDay.totals.durationMs===0,'An unrecorded day remains empty and does not inherit today or all-time gains');
  await page.getByRole('group',{name:'EXP dönemi',exact:true}).getByRole('button',{name:'Günlük',exact:true}).click();
  await page.getByLabel('EXP günü',{exact:true}).fill('2026-11-01');
  await page.waitForFunction(()=>document.querySelector('.solo-exp-history')?.getAttribute('data-solo-period')==='daily'&&document.querySelector('.solo-exp-history')?.getAttribute('data-solo-date')==='2026-11-01');
  await page.waitForFunction(name=>[...document.querySelectorAll('.solo-exp-character')].find(n=>n.getAttribute('aria-label')===name)?.querySelector('[data-solo-gained="base"]')?.textContent?.includes('61.000'),`${adventureNames[0]} EXP kazanımı`);
  check((await soloCard(0).locator('[data-solo-gained="base"]').innerText()).includes('61.000'),'Choosing an actual Replay day renders that character daily total');
  await capture('exp-daily-2026-11-01.png');
  await page.getByRole('button',{name:'Sonraki EXP günü',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.solo-exp-history')?.getAttribute('data-solo-date')==='2026-11-02');
  await page.getByRole('button',{name:'Önceki EXP günü',exact:true}).click();
  await page.getByRole('group',{name:'EXP dönemi',exact:true}).getByRole('button',{name:'Tümü',exact:true}).click();
  await select(0);await page.locator('.solo-exp-controls').getByRole('button',{name:'Yeni ölçüm',exact:true}).click();
  await page.getByRole('group',{name:'Yeni EXP ölçümü',exact:true}).getByRole('button',{name:'Yeni ölçümü başlat',exact:true}).click();
  await waitSession(0,{status:'running',observedDeaths:0});
  check(sessions(await state())[0].base.gained===0&&periodCharacter(await daily(),0)?.base.gained===61000,'Starting a new measurement resets its current counter without clearing the daily archive');
  await append(0,mobDeath(20500,1313,'Mobster',42),1000000);await waitSession(0,{observedDeaths:1});
  check(sessions(await state())[0].base.gained===20000&&periodCharacter(await daily(),0)?.base.gained===81000,'The new session contributes only its fresh award to the same day, preserving old session gains');
  await app.close();app=null;await launch();await goExperience();
  check(periodCharacter(await daily(),0)?.base.gained===81000&&(await daily('all')).totals.base.knownGained===96000,'Daily and all-time EXP archives survive a second native restart without double counting');
  value=await state();const live=await page.evaluate(()=>window.midgard.getLiveView());
  check(JSON.stringify(value.expansion.finance)===saved.finance&&JSON.stringify(await page.evaluate(()=>window.midgard.getFinanceView()))===saved.financeView&&JSON.stringify(await page.evaluate(()=>window.midgard.getKillView()))===saved.killView,'EXP actions preserve the finance ledger and Finance/Kill Count view preferences');
  check(JSON.stringify(value.assistance.preferences)===saved.alerts&&JSON.stringify(live.appearanceByCharacter)===JSON.stringify(saved.live.appearanceByCharacter)&&JSON.stringify(live.favoriteKeys)===JSON.stringify(saved.live.favoriteKeys),'Notification targets, alert preferences, appearances and favorite characters remain intact');
  check(errors.length===0,'No renderer errors');
  await app.close();app=null;const db=new DatabaseSync(fixture.database,{readOnly:true});try{check(db.prepare('PRAGMA quick_check').get()?.quick_check==='ok'&&db.prepare('PRAGMA foreign_key_check').all().length===0,'The isolated profile passes SQLite integrity and foreign-key checks');}finally{db.close();}
  const report={output,startedAt,completedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-started),executable:executable??'source electron .',passed:checks.length,checks,rendererErrors:errors,screenshots,geometry,scope:'Only generated Replay files and one private MIDGARD_USER_DATA profile; normal APIs, genuine file appends, pause/resume, missing-source recovery and restart. No real profile, game window, game memory or network accessed.',limits:'Proves configured solo estimates, not actual Skadi EXP or personal kill attribution. Percent is gain relative to a frozen starting-level requirement, not current progress. UI snapshots are synthetic.'};
  await writeFile(path.join(output,'solo-experience-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,passed:checks.length,rendererErrors:errors.length,screenshots:screenshots.length,durationMs:report.durationMs},null,2));
}catch(error){let diagnostic;try{const v=await state();diagnostic={streams:v.live?.streams.map(s=>({id:s.id,status:s.status,packetCount:s.packetCount})),experience:v.expansion?.killExperience};}catch{}await writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,checks,errors,geometry,diagnostic},null,2));try{await capture('failure.png');}catch{}throw error;}
finally{if(missingFile)await rename(missingFile.from,missingFile.to).catch(()=>{});await app?.close();}
