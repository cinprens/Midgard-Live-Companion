import {_electron as electron} from 'playwright';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {wait} from './qa-wait.mjs';

// Materialized synthetic history and a private profile; no user profile or real Replay is copied.
const output=path.resolve('.qa',`finance-workspace-${Date.now()}`),profile=path.join(output,'profile');
await mkdir(profile,{recursive:true});
await build({entryPoints:['electron/expansion-store.ts'],outfile:path.join(output,'store.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24',external:['node:*'],logLevel:'error'});
const {ExpansionStore}=createRequire(import.meta.url)(path.join(output,'store.cjs'));
const database=path.join(profile,'midgard-live.sqlite'),seed=new ExpansionStore(database);
seed.financeCommand({type:'price.set',price:{itemId:501,itemName:'QA Eski Kayıt',characterKey:null,npcPrice:null,marketPrice:42,buyCost:null,method:'market'}});
seed.financeCommand({type:'session.start',characterKey:'qa:legacy',characterName:'QA Eski Defter'});
seed.financeCommand({type:'receipt.add',sessionId:seed.financeState().sessions[0].id,itemId:501,itemName:'QA Eski Kayıt',quantity:1234,sourceKey:'SYNTHETIC-legacy'});
seed.close();
const db=new DatabaseSync(database),names=['Avcı 01','Avcı 02','Avcı 03'],keys=names.map((_,i)=>`qa:finance:${i}`);
const sample=[
  [603,'Old Blue Box',[8,6,4],35000],[746,'Glass Bead',[400,300,142],650],
  [510,'Blue Herb',[170,128,86],3000],[509,'White Herb',[600,400,240],750],
  [985,'Elunium',[20,12,10],12000],[984,'Oridecon',[18,12,8],9000],
  [2607,'Clip',[1,1,1],85000],[507,'Red Herb',[1000,800,600],80],
  [909,'Jellopy',[800,600,400],null],
];
const stamp='2026-11-02T12:00:00.000Z',start=Date.parse(stamp);
db.exec('BEGIN IMMEDIATE');
for(let i=0;i<3;i++){
  db.prepare('INSERT INTO autofarm_sessions VALUES(?,?,?,?,?,?,?)').run(`qa-session-${i}`,keys[i],names[i],`qa-record-${i}`,'replay-start','tracking',stamp);
  db.prepare('INSERT INTO autofarm_intervals VALUES(?,?,?,?,?)').run(`qa-interval-${i}`,`qa-session-${i}`,`qa-source-${i}`,start,start+8*3600000);
}
const total=db.prepare('INSERT INTO autofarm_item_totals VALUES(?,?,?,?)'),price=db.prepare('INSERT INTO autofarm_prices VALUES(?,?,?)');
for(let i=0;i<10000;i++){
  const known=sample[i],id=known?.[0]??900000+i,name=known?.[1]??(i===9999?'QA Çok Uzun Eşya Çığ İğne '.repeat(8):`QA Eşya ${String(i).padStart(5,'0')}`),quantities=known?.[2]??[i%6+1,(i%6+1)*2,(i%6+1)*3],unit=known?known[3]:i%7===0?null:i%19===0?0:(i%23+1)*25;
  for(let c=0;c<3;c++)total.run(keys[c],id,quantities[c],name);
  if(unit!==null)price.run(id,unit,stamp);
}
db.exec('COMMIT');db.close();
await writeFile(path.join(profile,'live-preferences.json'),JSON.stringify({version:1,sources:[],manualBindings:[],soundPaths:{},alerts:{muted:true,selectedCardIds:[],selectedMonsterIds:[1313],cityMaps:[],volume:0,weightThreshold:65,enabled:{death:true,weight:true,card:true,city:true,level:true,monster:true}}}));
const env={...process.env,MIDGARD_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.MIDGARD_DEV_URL;
let app,page;const checks=[],errors=[],screenshots=[];
const check=(value,label)=>{assert.ok(value,label);checks.push(label);};
const state=()=>page.evaluate(()=>window.midgard.getState());
const preferences=()=>page.evaluate(()=>window.midgard.getFinanceView());
const panel=()=>page.locator('.finance-workspace');
const search=()=>page.getByRole('textbox',{name:'Eşya adı veya ID ara',exact:true});
const field=id=>page.locator(`.finance-detail input[data-price-item-id="${id}"]`);
async function launch(){
  app=await electron.launch({...(process.argv[2]?{executablePath:path.resolve(process.argv[2]),args:[]}:{args:['.']}),env,timeout:30000});
  page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>!!window.midgard);await page.getByRole('navigation',{name:'Ana gezinme'}).getByRole('button',{name:'Finans',exact:true}).click();
  await panel().waitFor();await wait(page,async()=>!!window.midgard.getFinanceView&&(await window.midgard.getState()).expansion.autoFarm.items.length>=10000);
}
async function openItem(id,name){
  await search().fill(name);await page.locator(`.finance-workspace tr[data-farm-item-id="${id}"]`).getByRole('button',{name:`${name} ayrıntılarını aç`,exact:true}).click();await field(id).waitFor();
}
async function stored(id,value){await wait(page,async({id,value})=>(await window.midgard.getState()).expansion.autoFarm.prices.find(item=>item.itemId===id)?.unitPrice===value,{id,value});}
async function tab(label){const control=panel().getByRole('tab',{name:new RegExp(`^${label}`)});if(await control.count())await control.click();else await panel().getByRole('button',{name:new RegExp(`^${label}`)}).first().click();}
async function capture(name){await page.screenshot({path:path.join(output,name),fullPage:true});screenshots.push(name);}
try{
  const started=performance.now();await launch();const initialMs=Math.round(performance.now()-started),baseline=await state(),originalTotals=JSON.stringify(baseline.expansion.autoFarm.totals),legacy=JSON.stringify(baseline.expansion.finance);
  await page.locator('.finance-workspace tr[data-farm-item-id]').first().waitFor();
  check(await page.locator('.assistant-hero').count()===0,'Finance uses the compact header without the oversized hero');
  check(await page.locator('.assistant-audio-strip').count()===0,'Finance keeps audio controls compact in the top bar');
  check(await page.locator('.finance-stat').count()===3,'Only three compact KPI cards are shown');
  check(await page.locator('.finance-workspace tr[data-farm-item-id]').count()<=50,'Ten thousand item types render no more than fifty rows by default');
  check(await page.locator('.finance-workspace input[data-price-item-id]').count()===0,'The list creates no price input for every stored item');
  const kpiBefore=await page.locator('.finance-stat').first().innerText();
  const searchStart=performance.now();await search().fill('Old Blue Box');await page.locator('tr[data-farm-item-id="603"]').waitFor();const searchMs=Math.round(performance.now()-searchStart);
  check(await page.locator('.finance-workspace tr[data-farm-item-id]').count()===1,'Name search reduces the ten-thousand-item list to its match');
  await openItem(603,'Old Blue Box');
  check(await page.locator('.finance-workspace input[data-price-item-id]').count()===1,'Only the selected detail panel creates a price editor');
  check((await page.locator('.finance-detail').innerText()).includes('8 adet')&&(await page.locator('.finance-detail').innerText()).includes('6 adet')&&(await page.locator('.finance-detail').innerText()).includes('4 adet'),'Detail shows the existing per-character item distribution');
  await page.locator('tr[data-farm-item-id="603"]').getByRole('button',{name:'Old Blue Box favorilere ekle',exact:true}).click();
  await page.locator('.finance-detail').getByRole('button',{name:'Listeden gizle',exact:true}).click();
  await wait(page,async()=>{const v=await window.midgard.getFinanceView();return v.favoriteIds.includes(603)&&v.hiddenIds.includes(603);});
  check(JSON.stringify((await state()).expansion.autoFarm.totals)===originalTotals,'Favorite, search and hiding leave the full financial totals unchanged');
  check(await page.locator('.finance-stat').first().innerText()===kpiBefore,'The displayed scope KPI is not reduced by view filters');
  check(await page.locator('tr[data-farm-item-id="603"]').count()===0,'Hidden item leaves the default list');
  await tab('Favoriler');await page.locator('tr[data-farm-item-id="603"]').waitFor();check(true,'Favorite view can still reach a hidden favorite');
  await tab('Gizlenenler');await page.locator('tr[data-farm-item-id="603"]').waitFor();
  await page.locator('.finance-detail').getByRole('button',{name:'Listede göster',exact:true}).click();await tab('Tümü');
  await search().fill('');
  await page.getByRole('combobox',{name:'Sayfa başına eşya',exact:true}).selectOption('100');
  await page.waitForTimeout(100);check(await page.locator('.finance-workspace tr[data-farm-item-id]').count()<=100,'Page size is explicitly bounded at one hundred rows');
  const originalLeader=await page.locator('.finance-workspace tr[data-farm-item-id]').first().getAttribute('data-farm-item-id');
  await page.evaluate(()=>window.midgard.setFarmPrice({itemId:510,unitPrice:1}));await stored(510,1);
  check(await page.locator('.finance-workspace tr[data-farm-item-id]').first().getAttribute('data-farm-item-id')===originalLeader,'Live price updates preserve the accepted row order');
  await page.getByRole('button',{name:'Sıralamayı yenile',exact:true}).click();
  check(await page.locator('.finance-workspace tr[data-farm-item-id]').first().getAttribute('data-farm-item-id')!==originalLeader,'Explicit refresh applies current price ordering without waiting for a new item type');
  await page.evaluate(()=>window.midgard.setFarmPrice({itemId:510,unitPrice:3000}));await stored(510,3000);
  await page.getByRole('button',{name:'Sıralamayı yenile',exact:true}).click();
  const firstPageIds=await page.locator('.finance-workspace tr[data-farm-item-id]').evaluateAll(rows=>rows.map(row=>row.dataset.farmItemId));
  await page.getByRole('button',{name:'Sonraki sayfa',exact:true}).click();
  check((await page.locator('.finance-workspace tr[data-farm-item-id]').first().getAttribute('data-farm-item-id'))!==firstPageIds[0],'Paging changes rows rather than rendering all history');
  await page.getByRole('combobox',{name:'Karakter seç',exact:true}).selectOption(keys[0]);
  check((await panel().innerText()).includes(names[0]),'Character scope is visible');
  check(JSON.stringify((await state()).expansion.autoFarm.totals)===originalTotals,'Changing the display character leaves backend totals unchanged');
  await page.getByRole('combobox',{name:'Karakter seç',exact:true}).selectOption('');
  await openItem(603,'Old Blue Box');
  for(const [text,value]of [['35.000',35000],['35.000,50',35000.5],['0',0],['',null],['35000',35000]]){
    await field(603).fill(text);await field(603).press('Tab');await stored(603,value);
  }
  check(true,'Turkish grouping, decimal comma, true zero and unknown price save to their exact numeric values');
  await field(603).fill('-1');await page.waitForTimeout(650);
  check(await page.locator('.finance-detail [role="alert"]').count()>0&&(await state()).expansion.autoFarm.prices.find(item=>item.itemId===603).unitPrice===35000,'Invalid price remains an inline error and preserves the saved price');
  await field(603).fill('41.234');
  const live=new DatabaseSync(database);live.exec('BEGIN IMMEDIATE');live.prepare('UPDATE autofarm_item_totals SET quantity=quantity+1 WHERE character_key=? AND item_id=?').run(keys[0],603);live.prepare('INSERT INTO autofarm_item_totals VALUES(?,?,?,?)').run(keys[0],9900100,1,'QA Yeni Canlı Eşya');live.prepare('INSERT INTO autofarm_prices VALUES(?,?,?)').run(9900100,999999,stamp);live.exec('COMMIT');live.close();
  // Re-publishing the new item price invalidates the materialized snapshot without intentionally overwriting the editor's price.
  await page.evaluate(()=>window.midgard.setFarmPrice({itemId:9900100,unitPrice:999999}));
  check(await field(603).inputValue()==='41.234','Live state refresh does not overwrite an in-progress price draft');
  check(await field(603).evaluate(node=>document.activeElement===node),'Price focus survives a live state refresh');
  await stored(603,41234);
  check(await page.locator('.finance-new-items').count()>0,'A new item type is announced without reordering the current list');
  await page.getByRole('button',{name:'Listeyi yenile',exact:true}).click();await search().fill('QA Yeni Canlı Eşya');await page.locator('tr[data-farm-item-id="9900100"]').waitFor();check(true,'User can explicitly reveal newly received item types');
  await search().fill('');await tab('Fiyat bekleyen');await page.locator('.finance-workspace tr[data-farm-item-id]').first().getByRole('button',{name:/ayrıntılarını aç/}).click();
  const firstUnpriced=Number(await page.locator('.finance-detail').getAttribute('data-detail-item-id'));
  await field(firstUnpriced).fill('125');await field(firstUnpriced).press('Enter');await stored(firstUnpriced,125);
  await page.waitForFunction(id=>document.querySelector('.finance-detail')?.getAttribute('data-detail-item-id')!==String(id),firstUnpriced);
  check(true,'Explicit Enter in the unpriced queue saves successfully before advancing');
  await tab('Tümü');await openItem(603,'Old Blue Box');await field(603).press('Escape');
  await search().fill('');await openItem(603,'Old Blue Box');await search().fill('');
  await page.getByRole('button',{name:'Siyah tema',exact:true}).click();await capture('finance-dark-1480.png');
  await page.getByRole('button',{name:'Açık tema',exact:true}).click();await capture('finance-light-1480.png');
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Finance fits the 1480 pixel desktop width');
  await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows()[0].setSize(1100,820));await page.waitForTimeout(120);await capture('finance-light-1100.png');
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Finance fits the 1100 pixel desktop width with the detail panel open');
  await page.getByRole('button',{name:'Siyah tema',exact:true}).click();await capture('finance-dark-1100.png');
  const savedView=await preferences(),savedFarm=(await state()).expansion.autoFarm;
  check(JSON.stringify((await state()).expansion.finance)===legacy,'Legacy financial ledger stays byte-equivalent as UI preferences and shared prices change');
  await app.close();app=null;await launch();
  check(JSON.stringify(await preferences())===JSON.stringify(savedView),'Favorite, hidden, page size, scope and sort preferences survive application restart');
  const restored=(await state()).expansion.autoFarm;
  check(restored.totals.quantity===savedFarm.totals.quantity&&restored.totals.knownValue===savedFarm.totals.knownValue,'Shared prices and materialized income quantities survive restart unchanged');
  check(errors.length===0,'No renderer errors');
  const report={output,executable:process.argv[2]?path.resolve(process.argv[2]):'source electron .',initialItemTypes:10000,initialMs,searchMs,passed:checks.length,checks,rendererErrors:errors,screenshots,scope:'Generated materialized history in a private profile. Live refresh uses isolated SQL fixture updates and the normal price publication API. No user profile or actual Replay copied. Search timing includes automation overhead.'};
  await writeFile(path.join(output,'finance-workspace-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await writeFile(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:String(error),stack:error.stack},null,2));try{await capture('failure.png');}catch{}throw error;}finally{await app?.close();}
