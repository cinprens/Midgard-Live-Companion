import {_electron as electron} from 'playwright';
import {mkdir,writeFile,open,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {assistanceReplay,status} from './assistance-fixtures.mjs';
import {bagBaseline,cardReceived} from './auto-farm-fixtures.mjs';
import {mobDeath} from './kill-count-fixtures.mjs';
import {wait} from './qa-wait.mjs';

// Synthetic wire data and an isolated profile. No user Replay or profile is copied.
const output=path.resolve('.qa',`live-workspace-${Date.now()}`),profile=path.join(output,'profile'),sources=path.join(output,'sources');
await mkdir(profile,{recursive:true});await mkdir(sources,{recursive:true});
const names=['Avcı Çağrı','Avcı İpek','Avcı Özgür'],players=[42,43,44],weights=[61000,78000,42000],hp=[4100,4700,3350];
const files=names.map((_,index)=>path.join(sources,`SYNTHETIC-live-${index+1}.rrf`));
const timed=(time,packets)=>packets.map(data=>({time,data}));
const entries=names.map((_,i)=>[...timed(0,[...bagBaseline(),status(24,weights[i]),status(6,5000),status(5,hp[i])]),...timed(10000,mobDeath(1000,1313,'Mobster',players[i])),...(i<2?timed(250000,mobDeath(1001,1313,'Mobster',players[i])):[]),...(i===0?timed(610000,mobDeath(1002,1313,'Mobster',players[i])):[]),...timed(300000,[cardReceived(501,i+3,7),cardReceived(999999,2,8)]),...timed(670000,[status(6,5000)])]);
function fixture(index,character=names[index],player=players[index],items=entries[index]){const ordered=[...items].sort((a,b)=>a.time-b.time),bytes=assistanceReplay({character,player,packets:ordered.map(item=>item.data)});let at=352;for(const item of ordered){bytes.writeInt32LE(item.time,at+4);at+=10+item.data.length;}return bytes;}
for(let i=0;i<3;i++)await writeFile(files[i],fixture(i));
await writeFile(path.join(profile,'live-preferences.json'),JSON.stringify({version:1,sources:[],manualBindings:[],soundPaths:{},alerts:{muted:true,selectedCardIds:[4317],selectedMonsterIds:[1313],cityMaps:['prontera'],volume:0,weightThreshold:65,enabled:{death:true,weight:true,card:true,city:true,level:true,monster:true}}}));
const env={...process.env,MIDGARD_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.MIDGARD_DEV_URL;
let app,page;const checks=[],errors=[],screenshots=[],geometry=[];
const check=(value,label)=>{assert.ok(value,label);checks.push(label);};
const state=()=>page.evaluate(()=>window.midgard.getState());
const view=()=>page.evaluate(()=>window.midgard.getLiveView());
const row=id=>page.locator(`.live-character-row[data-stream-id="${id}"]`),detail=()=>page.locator('.live-detail');
const search=()=>page.getByRole('textbox',{name:'Karakter ara',exact:true});
const clearFlashes=()=>page.evaluate(()=>document.querySelectorAll('.assistant-flash button').forEach(button=>button.click()));
async function launch(){app=await electron.launch({...(process.argv[2]?{executablePath:path.resolve(process.argv[2]),args:[]}:{args:['.']}),env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.waitForFunction(()=>!!window.midgard);await page.locator('.live-workspace').waitFor();}
async function add(paths){await app.evaluate(({dialog},filePaths)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths});},paths);await page.evaluate(()=>window.midgard.addLiveFiles());await wait(page,async()=>{const s=(await window.midgard.getState()).live;return s.streams.every(stream=>stream.summary&&stream.status==='settled')&&!s.activeWorkers&&!s.queuedCount;},null,{timeout:45000});}
async function select(name){await search().fill(name);await page.getByRole('button',{name:`${name} ayrıntılarını aç`,exact:true}).click();await detail().waitFor();await search().fill('');}
async function capture(name){await clearFlashes();await page.screenshot({path:path.join(output,name),fullPage:true});screenshots.push(name);}
async function showSourceFile(filename){for(let attempt=0;attempt<40;attempt++){if((await detail().locator('.live-source-field').innerText()).includes(filename))return;const next=page.getByRole('button',{name:'Sonraki kaynak ayrıntısı',exact:true});if(await next.isDisabled())break;await next.click();}throw new Error(`Selected source filename was not accessible: ${filename}`);}
async function noScroll(label){const values=await page.evaluate(()=>{const root=document.documentElement,items=[...document.querySelectorAll('.live-workspace,.live-content,.live-detail,.live-runtime,.live-roster-panel,.live-character-row,.live-character-card-body')].filter(node=>node.getClientRects().length).map(node=>({selector:node.className,width:node.clientWidth,scrollWidth:node.scrollWidth,height:node.clientHeight,scrollHeight:node.scrollHeight}));return{width:innerWidth,height:innerHeight,scrollWidth:root.scrollWidth,scrollHeight:root.scrollHeight,items};});geometry.push({label,...values});const fits=values.scrollWidth<=values.width+1&&values.scrollHeight<=values.height+1&&values.items.every(item=>item.scrollWidth<=item.width+1&&item.scrollHeight<=item.height+1);if(!fits)await writeFile(path.join(output,'scroll-failure.json'),JSON.stringify({label,...values},null,2));check(fits,`${label}: document, workspace and visible panes fit without scrolling`);return values;}
async function append(index,packets,time){entries[index].push(...timed(time,packets));const bytes=fixture(index),file=await open(files[index],'r+');try{await file.write(bytes,0,bytes.length,0);await file.truncate(bytes.length);}finally{await file.close();}const hash=createHash('sha256').update(bytes).digest('hex');await wait(page,async({file,hash})=>{const stream=(await window.midgard.getState()).live.streams.find(stream=>stream.sourcePath===file);return stream?.contentHash===hash;},{file:files[index],hash},{timeout:30000});}
try{
  await launch();await noScroll('Empty live view');
  await page.evaluate(async()=>{await window.midgard.setFinanceView({version:1,favoriteIds:[603],hiddenIds:[746],characterKey:null,tab:'favorites',sort:'name-asc',pageSize:100});await window.midgard.setKillView({version:1,favoriteIds:[1313],pinnedTargetId:null,characterKey:null,tab:'live',sort:'recent-desc',pageSize:100,onlyFavorites:false,recordingKey:null});});
  const started=performance.now();await add(files);const initialMs=Math.round(performance.now()-started),initial=await state();
  check(initial.expansion.killCount.totals.observedDeaths===6&&initial.expansion.targetHunt.targets.find(target=>target.monsterId===1313).deathCount===3,'Three sources retain six raw character observations and three approximate common target observations');
  check(await page.locator('.live-character-row').count()===3,'Three explicitly added characters appear without an extra refresh');
  check(await page.locator('.assistant-hero,.assistant-audio-strip').count()===0,'Live uses the compact header without duplicate large banners');
  check(await page.locator('.live-workspace input[data-price-item-id],.live-workspace .farm-price-field').count()===0,'Live creates no hidden per-item price editors');
  const second=initial.live.streams.find(stream=>stream.character.name===names[1]),first=initial.live.streams.find(stream=>stream.character.name===names[0]);
  const originalFinanceView=await page.evaluate(()=>window.midgard.getFinanceView()),originalKillView=await page.evaluate(()=>window.midgard.getKillView());
  const originalLedger=JSON.stringify(initial.expansion.finance);
  const searchStart=performance.now();await search().fill('ipek');await page.getByRole('button',{name:`${names[1]} ayrıntılarını aç`,exact:true}).waitFor();const searchMs=Math.round(performance.now()-searchStart);check(await page.locator('.live-character-row').count()===1,'Turkish accent-insensitive search finds the requested character');
  await page.getByRole('button',{name:`${names[1]} ayrıntılarını aç`,exact:true}).click();await search().fill('');
  check((await detail().locator('[data-live-character-target]').innerText()).trim().startsWith('2'),'The open character panel displays its own target-monster observation count');
  check((await page.locator('[data-live-global-target]').innerText()).startsWith('3'),'The shared target strip keeps its separate all-source count');
  check((await detail().innerText()).includes('78')&&(await detail().innerText()).includes('94')&&(await detail().innerText()).includes('65'),'The selected source supplies HP, weight and configured threshold');
  await page.evaluate(()=>window.midgard.setFarmPrice({itemId:501,unitPrice:500}));
  await wait(page,async()=>{const s=await window.midgard.getState();return s.expansion.autoFarm.prices.some(item=>item.itemId===501&&item.unitPrice===500);});
  check((await detail().locator('.live-farm-summary').innerText()).includes('Kısmi'),'Missing item prices stay explicitly partial in the read-only Farm summary');
  await page.getByRole('checkbox',{name:'Dikkat gerekenler',exact:true}).check();check(await page.locator('.live-character-row').count()===1,'Attention filter isolates the one selected-source weight warning');await page.getByRole('checkbox',{name:'Dikkat gerekenler',exact:true}).uncheck();
  await row(second.id).getByRole('button',{name:new RegExp('favorilere ekle$')}).click();await wait(page,async key=>(await window.midgard.getLiveView()).favoriteKeys.includes(key),second.character.key);check(true,'Character favorites are persisted independently of sound targets');
  await append(0,[...mobDeath(1003,1313,'Mobster',players[0]),status(24,70000),status(6,5000)],730000);await wait(page,async()=>(await window.midgard.getState()).expansion.targetHunt.targets[0].deathCount===4);
  check(await detail().getAttribute('data-live-character')===second.character.key&&(await detail().locator('[data-live-character-target]').innerText()).trim().startsWith('2'),'An unrelated source update preserves selected character and its scoped target count');
  await append(1,[...mobDeath(1004,1313,'Mobster',players[1]),status(6,5000)],750000);await page.waitForFunction(()=>document.querySelector('[data-live-character-target]')?.textContent?.trim().startsWith('3'));check(true,'A new selected-character target observation updates its open panel automatically');
  await clearFlashes();
  for(const [width,height]of [[1480,1000],[1100,820],[1100,720]]){
    const shotSize=height===720?'1100x720':String(width);
    await app.evaluate(({BaseWindow},size)=>BaseWindow.getAllWindows()[0].setSize(...size),[width,height]);
    for(const theme of ['Siyah','Açık']){await page.getByRole('button',{name:`${theme} tema`,exact:true}).click();await page.waitForTimeout(100);await noScroll(`${theme} ${width}×${height} summary`);await capture(`live-${theme==='Siyah'?'dark':'light'}-${shotSize}.png`);}
    await detail().getByRole('button',{name:'Kaynak bilgileri',exact:true}).click();await showSourceFile(path.basename(files[1]));await noScroll(`${width}×${height} source details`);check((await detail().innerText()).includes(path.basename(files[1])),'Source details show the actual selected file');
    await capture(`live-source-${shotSize}.png`);await detail().getByRole('button',{name:'Karakter eşleştirme',exact:true}).click();await noScroll(`${width}×${height} character binding`);await capture(`live-binding-${shotSize}.png`);await detail().getByRole('button',{name:'Özete dön',exact:true}).click();
  }
  await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows()[0].setSize(1480,1000));
  await page.getByRole('button',{name:'Takip ve kaynak bilgileri',exact:true}).click();await noScroll('Runtime source information');await page.getByRole('button',{name:'Karakterlere dön',exact:true}).click();
  const duplicate=path.join(sources,'SYNTHETIC-live-1-copy.rrf'),copyEntries=[...entries[0],...timed(760000,[status(5,4950)])];await writeFile(duplicate,fixture(0,names[0],players[0],copyEntries));await add([duplicate]);
  await select(names[0]);check((await state()).live.streams.length===4&&await page.locator('.live-character-row').count()===3,'Two Replay files for the same character form one row without duplicating its totals');
  await detail().getByRole('button',{name:'Kaynak bilgileri',exact:true}).click();const duplicateStream=(await state()).live.streams.find(stream=>stream.sourcePath===duplicate);await page.getByRole('combobox',{name:'Karakter kaynağı',exact:true}).selectOption(duplicateStream.id);
  await detail().getByRole('button',{name:'Duraklat',exact:true}).click();await wait(page,async id=>(await window.midgard.getState()).live.streams.find(stream=>stream.id===id).status==='paused',duplicateStream.id);
  check((await state()).live.streams.find(stream=>stream.id===first.id).status!=='paused','Pause affects only the selected source while its sibling continues');
  await detail().getByRole('button',{name:'Devam et',exact:true}).click();await wait(page,async id=>!['paused','stopped'].includes((await window.midgard.getState()).live.streams.find(stream=>stream.id===id).status),duplicateStream.id);await detail().getByRole('button',{name:'Özete dön',exact:true}).click();
  check((await view()).sourcePath===duplicate,'The selected source preference stores its stable file path');
  await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows()[0].setSize(1100,720));
  await page.waitForTimeout(100);
  await noScroll('1100×720 multiple sources summary');
  await detail().getByRole('button',{name:'Kaynak bilgileri',exact:true}).click();await noScroll('1100×720 multiple sources detail');
  await detail().getByRole('button',{name:'Karakter eşleştirme',exact:true}).click();await noScroll('1100×720 multiple sources binding');await capture('live-multiple-sources-binding-1100x720.png');
  await detail().getByRole('button',{name:'Özete dön',exact:true}).click();await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows()[0].setSize(1480,1000));
  await app.evaluate(({BaseWindow},streamId)=>{const win=BaseWindow.getAllWindows()[0];for(let i=0;i<45;i++)win.contentView.children[0].webContents.send('midgard:notification',{id:`qa-injected-${i}`,type:'weight',streamId,character:'QA Uyarı',at:new Date().toISOString(),message:`SYNTHETIC bildirim ${i}`});},first.id);
  await page.waitForFunction(()=>document.querySelector('.live-alerts header')?.textContent?.includes('30'));await clearFlashes();check(await page.locator('.live-alert-item').count()<=2,'The recent notification feed is bounded and only a small page is rendered');
  const more=[];for(let i=0;i<12;i++){const file=path.join(sources,`SYNTHETIC-more-${i}.rrf`);await writeFile(file,fixture(2,`QA Ek Karakter ${i}`,100+i));more.push(file);}await add(more);await page.getByRole('button',{name:'Karakter listesini yenile',exact:true}).click();await noScroll('Many-character pagination');check(await page.locator('.live-character-row').count()<=10,'A growing source list remains a bounded page rather than a growing wall of cards');
  check(JSON.stringify((await state()).expansion.finance)===originalLedger&&JSON.stringify(await page.evaluate(()=>window.midgard.getFinanceView()))===JSON.stringify(originalFinanceView),'Live source controls, favorites and filters leave the legacy ledger and Finance preferences unchanged');
  await detail().locator('.live-farm-summary').getByRole('button',{name:'Finans’ta aç',exact:true}).click();await page.locator('.finance-workspace').waitFor();check(await page.getByRole('combobox',{name:'Karakter seç',exact:true}).inputValue()===first.character.key,'Finance opens in the selected character scope');
  const scopedFinance=await page.evaluate(()=>window.midgard.getFinanceView());check(scopedFinance.favoriteIds.includes(603)&&scopedFinance.hiddenIds.includes(746)&&scopedFinance.sort==='name-asc'&&scopedFinance.pageSize===100,'Cross-page Finance navigation preserves pre-existing favorites, hidden items and view settings');
  await page.getByRole('navigation',{name:'Ana gezinme'}).getByRole('button',{name:/^Canlı takip/}).click();await page.locator('.live-workspace').waitFor();
  check(JSON.stringify(await page.evaluate(()=>window.midgard.getKillView()))===JSON.stringify(originalKillView),'Live favorites and source controls leave Kill Count preferences unchanged');
  const saved=await view(),beforeRestart=await state();await app.close();app=null;await launch();await wait(page,async()=>{const s=(await window.midgard.getState()).live;return s.streams.length===16&&s.streams.every(stream=>stream.summary&&stream.status==='settled');},null,{timeout:45000});
  check(JSON.stringify(await view())===JSON.stringify(saved),'Live favorites, filters and selection survive a clean restart');check((await state()).expansion.killCount.totals.observedDeaths===beforeRestart.expansion.killCount.totals.observedDeaths,'Restart reads no duplicate history into the kill totals');
  check(await detail().getAttribute('data-live-source')===(await state()).live.streams.find(stream=>stream.sourcePath===duplicate).id,'The selected file is restored even though runtime source IDs changed');await noScroll('Restarted workspace');
  check(errors.length===0,'No renderer errors');
  const report={output,executable:process.argv[2]?path.resolve(process.argv[2]):'source electron .',passed:checks.length,checks,rendererErrors:errors,initialMs,searchMs,screenshots,geometry,scope:'Synthetic RRF files and isolated profile. Injected notifications only test the bounded renderer feed. No user profile/game file copied; audio remains zero-volume. Timings include automation overhead.'};await writeFile(path.join(output,'live-workspace-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,executable:report.executable,passed:report.passed,rendererErrors:errors.length,initialMs,searchMs,screenshots,geometryChecks:geometry.length},null,2));
}catch(error){await writeFile(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:String(error),stack:error.stack},null,2));try{await capture('failure.png');}catch{}throw error;}finally{await app?.close();}
