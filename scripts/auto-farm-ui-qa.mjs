import {_electron as electron} from 'playwright';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {mkdir,writeFile,open} from 'node:fs/promises';
import {assistanceReplay,bagBaseline,cardReceived,status,groundOnly,removeFromBag,tradeReceipt} from './auto-farm-fixtures.mjs';
import {wait} from './qa-wait.mjs';

// Isolated generated sources and historical finance fixtures only. No real gameplay is copied.
const output=path.resolve('.qa',`auto-farm-ui-${Date.now()}`),sources=path.join(output,'sources'),profile=path.join(output,'profile');
await mkdir(sources,{recursive:true});const names=['QA Çanta Çağrı','QA Çanta İpek','QA Çanta Özgür'],files=names.map((_,index)=>path.join(sources,`SYNTHETIC-bag-${index+1}.rrf`));
const packets=names.map(()=>bagBaseline());for(let index=0;index<3;index++)await writeFile(files[index],assistanceReplay({character:names[index],player:42+index,packets:packets[index]}));
const catalog=path.join(sources,'SYNTHETIC-catalog.json');await writeFile(catalog,JSON.stringify({schemaVersion:1,source:{id:'qa-autobag',name:'Sentetik çanta testi',url:'user:synthetic-qa',license:'CC0-1.0 generated test facts',version:'1',updatedAt:'2026-11-01',permission:'user-provided'},records:[{kind:'item',id:'501',name:'QA Earthworm Peeling',npcSell:null}]}));
const env={...process.env,MIDGARD_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.MIDGARD_DEV_URL;
let app;const checks=[],errors=[];const assert=(value,name)=>{if(!value)throw Error(name);checks.push(name);};
const stateOf=page=>page.evaluate(()=>window.midgard.getState());const farmOf=async page=>(await stateOf(page)).expansion.autoFarm;
async function launch(){const value=await electron.launch({...(process.argv[2]?{executablePath:path.resolve(process.argv[2]),args:[]}:{args:['.']}),env,timeout:30000});const page=await value.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.waitForFunction(()=>!!window.midgard);await page.waitForSelector('h1');return{app:value,page};}
const settle=page=>wait(page,async()=>{const state=await window.midgard.getState();return state.live.streams.length===3&&!state.live.activeWorkers&&!state.live.queuedCount&&state.live.streams.every(stream=>stream.summary&&stream.status==='settled');},{},{timeout:30000});
async function grow(index,extra){packets[index].push(...extra);const bytes=assistanceReplay({character:names[index],player:42+index,packets:packets[index]}),handle=await open(files[index],'r+');try{await handle.write(bytes.subarray(352),0,bytes.length-352,352);await handle.write(bytes.subarray(0,352),0,352,0);await handle.sync();}finally{await handle.close();}}
async function ensureItemField(page,id){const input=page.locator(`.finance-detail input[data-price-item-id="${id}"]`);if(!await input.count()){await page.getByRole('textbox',{name:'Eşya adı veya ID ara',exact:true}).fill(String(id));await page.locator(`tr[data-farm-item-id="${id}"] .finance-item-link`).click();}return input;}
const itemField=(page,id)=>({fill:async value=>(await ensureItemField(page,id)).fill(value),press:async key=>(await ensureItemField(page,id)).press(key)});
const totalText=page=>page.locator('.finance-stat').first().locator('strong').first().innerText();
async function saved(page,id,price){await wait(page,async({id,price})=>(await window.midgard.getState()).expansion.autoFarm.prices.some(value=>value.itemId===id&&value.unitPrice===price),{id,price});}
try{
  // Build a complete old schema using the application, then simulate the previous migration version.
  let launched=await launch();app=launched.app;await app.close();app=null;
  const db=new DatabaseSync(path.join(profile,'midgard-live.sqlite'));
  db.exec('PRAGMA foreign_keys=OFF; BEGIN; DROP TABLE kill_count_totals; DROP TABLE kill_count_events; DROP TABLE kill_count_intervals; DROP TABLE kill_count_sessions; DROP INDEX catalog_monster_lookup; DROP TABLE autofarm_receipts; DROP TABLE autofarm_intervals; DROP TABLE autofarm_cursors; DROP TABLE autofarm_item_totals; DROP TABLE autofarm_prices; DROP TABLE autofarm_sessions; DROP INDEX catalog_item_lookup; DELETE FROM expansion_migrations WHERE version>1;');
  const oldPrice={itemId:501,itemName:'QA Earthworm Peeling',characterKey:null,npcPrice:null,marketPrice:10,buyCost:null,method:'market',updatedAt:'2026-11-01T00:00:00.000Z'};
  db.prepare('INSERT INTO item_prices VALUES(?,?)').run('legacy-shared',JSON.stringify(oldPrice));db.prepare('INSERT INTO item_prices VALUES(?,?)').run('legacy-character',JSON.stringify({...oldPrice,characterKey:'legacy-character',marketPrice:999}));
  const oldSession={id:'legacy-session',characterKey:'legacy-character',characterName:'Eski manuel karakter',startedAt:'2026-10-01T00:00:00.000Z',endedAt:'2026-10-01T01:00:00.000Z',status:'closed',intervals:[{startedAt:'2026-10-01T00:00:00.000Z',endedAt:'2026-10-01T01:00:00.000Z'}],note:'Synthetic legacy preservation test'};
  const oldReceipt={id:'legacy-receipt',kind:'receipt',at:'2026-10-01T00:00:00.000Z',sessionId:oldSession.id,characterKey:oldSession.characterKey,itemId:501,itemName:'QA Earthworm Peeling',quantity:999999,source:'manual',classification:'farm',price:{unitValue:10,method:'market',updatedAt:oldPrice.updatedAt,scope:'shared'}};
  db.prepare('INSERT INTO farm_sessions VALUES(?,?,?)').run(oldSession.id,oldSession.characterKey,JSON.stringify(oldSession));db.prepare('INSERT INTO finance_transactions VALUES(?,?,?,?)').run(oldReceipt.id,'receipt',null,JSON.stringify(oldReceipt));db.exec('COMMIT;');db.close();
  launched=await launch();app=launched.app;let page=launched.page,state=await stateOf(page);
  assert(state.expansion.autoFarm.prices.find(value=>value.itemId===501)?.unitPrice===10&&state.expansion.finance.events.length===1,'Migration preserves the old ledger and inherits only its shared price');
  await page.getByRole('button',{name:'Finans',exact:true}).click();
  assert(await page.getByText('Envanter verisi bekleniyor',{exact:true}).count()>0&&await totalText(page)==='—','No receipt means waiting text and no invented zero income');
  assert(await page.locator('.finance-workspace input[data-price-item-id]').count()===0&&await page.locator('.finance-workspace button').filter({hasText:/Oturum|Kazanım ekle|Satış|Gider|Transfer/}).count()===0,'Finance contains no manual quantity, session, ledger, sale, expense or transfer controls');
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},catalog);await page.evaluate(()=>window.midgard.importCatalog());await wait(page,async()=>(await window.midgard.getState()).expansion.catalog.counts.item===1);
  await page.getByRole('button',{name:/^Canlı takip/}).click();await app.evaluate(({dialog},filePaths)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths});},files);await page.getByRole('button',{name:'Dosya seç',exact:true}).first().click();await settle(page);
  assert((await farmOf(page)).items.length===0,'Initial bag snapshots containing 20 items per character never count as new farm receipts');
  await grow(0,[groundOnly(),cardReceived(501,125),status(5,10000)]);await grow(1,[cardReceived(501,40),status(5,10000)]);await grow(2,[cardReceived(501,10),cardReceived(999999,2,8),status(5,10000)]);
  await wait(page,async()=>{const farm=(await window.midgard.getState()).expansion.autoFarm;return farm.items.find(value=>value.itemId===501)?.quantity===175&&farm.items.find(value=>value.itemId===999999)?.quantity===2;});await settle(page);
  let farm=await farmOf(page);
  assert(farm.characters.filter(value=>value.available).length===3&&farm.totals.quantity===177,'Three new inventory streams aggregate 175 known and 2 unknown items automatically');
  assert(farm.items.find(value=>value.itemId===501).quantity===175,'A 999-unit ground observation is excluded from bag receipt quantities');
  assert(farm.items.find(value=>value.itemId===501).itemName==='QA Earthworm Peeling'&&farm.items.find(value=>value.itemId===999999).itemName.includes('999999'),'Item names resolve from the local catalog and unknown IDs stay visible');
  assert(farm.totals.knownValue===1750&&farm.totals.estimatedValue===null&&farm.totals.unpricedItems===1,'Inherited shared price applies automatically while unknown prices remain partial');
  await page.getByRole('button',{name:'Finans',exact:true}).click();await ensureItemField(page,501);assert(await page.locator('.finance-workspace input[data-price-item-id]').count()===1,'Only the selected item opens one shared unit price editor');
  await itemField(page,501).fill('5');await itemField(page,501).fill('50');await itemField(page,501).fill('500');
  assert((await totalText(page)).includes('87.500')&&(await farmOf(page)).prices.find(value=>value.itemId===501).unitPrice===10,'Typing revalues the visible total immediately before the debounced write');
  await saved(page,501,500);assert((await farmOf(page)).totals.knownValue===87500,'Price is saved automatically after typing without a Save button');
  farm=await farmOf(page);assert(farm.characters.every(value=>value.items.find(item=>item.itemId===501)?.unitPrice===500),'One price is reused by all three characters');
  await itemField(page,999999).fill('1000');await itemField(page,999999).press('Enter');await saved(page,999999,1000);assert((await farmOf(page)).totals.estimatedValue===89500,'Enter saves an unknown-item price and completes the total');
  await itemField(page,501).fill('600');await saved(page,501,600);assert((await farmOf(page)).totals.estimatedValue===107000,'Changing a shared price instantly revalues all previously observed quantities');
  await grow(1,[cardReceived(501,5),status(5,10000)]);await wait(page,async()=>(await window.midgard.getState()).expansion.autoFarm.totals.estimatedValue===110000);assert(true,'A later receipt inherits the stored price without further user input');
  await grow(0,[removeFromBag(50),status(5,10000)]);await grow(2,tradeReceipt());await settle(page);await page.waitForTimeout(2200);farm=await farmOf(page);
  assert(farm.totals.quantity===182&&farm.totals.estimatedValue===110000,'Repeated reads, bag removals and known player trade do not duplicate or subtract farm value');
  await itemField(page,999999).fill('-1');await page.waitForTimeout(650);assert(await page.locator('.farm-price-field.error').count()===1&&(await farmOf(page)).prices.find(value=>value.itemId===999999).unitPrice===1000,'Invalid prices show an inline error and preserve the last saved value');
  await itemField(page,999999).fill('');await page.getByRole('heading',{name:'Finans',exact:true}).click();await saved(page,999999,null);assert((await farmOf(page)).totals.partial&&(await farmOf(page)).totals.knownValue===108000,'Blur saves a cleared price as unknown, with a separate unpriced quantity');
  await itemField(page,999999).fill('0');await itemField(page,999999).press('Enter');await saved(page,999999,0);assert((await farmOf(page)).totals.estimatedValue===108000&&!(await farmOf(page)).totals.partial,'A deliberately entered zero price is valid and is not treated as missing');
  await itemField(page,999999).fill('1000');await itemField(page,999999).press('Enter');await saved(page,999999,1000);
  await page.getByRole('button',{name:/^Canlı takip/}).click();state=await stateOf(page);const first=state.live.streams.find(value=>value.character.name===names[0]);
  await page.getByRole('button',{name:first.character.name+' ayrıntılarını aç',exact:true}).click();
  assert(await page.locator('.live-workspace input[data-price-item-id]').count()===0&&await page.locator('.live-farm-summary').count()===1,'Live character Farm is a read-only summary with no hidden price inputs');
  await page.locator('.live-farm-summary').getByRole('button',{name:'Finans’ta aç',exact:true}).click();
  await itemField(page,501).fill('650');await itemField(page,501).press('Enter');await saved(page,501,650);assert((await farmOf(page)).totals.estimatedValue===119000,'Finance edits the common price and updates all Live character summaries');
  await page.getByRole('button',{name:/^Canlı takip/}).click();
  farm=await farmOf(page);const characterTime=farm.characters.reduce((sum,value)=>sum+value.totals.durationMs,0),longest=Math.max(...farm.characters.map(value=>value.totals.durationMs));assert(farm.totals.durationMs>=longest&&farm.totals.durationMs<characterTime,'Combined hourly valuation uses overlapping real Replay time once');
  await page.screenshot({path:path.join(output,'live-farm-1480.png'),fullPage:true});await page.getByRole('button',{name:'Finans',exact:true}).click();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Simple Finance fits the 1480 pixel layout');await page.screenshot({path:path.join(output,'auto-finance-1480.png'),fullPage:true});
  await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows()[0].setSize(1280,900));await page.waitForTimeout(150);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Simple Finance fits the 1280 pixel layout');await page.screenshot({path:path.join(output,'auto-finance-1280.png'),fullPage:true});
  await page.getByRole('button',{name:/^Canlı takip/}).click();await page.screenshot({path:path.join(output,'live-farm-1280.png'),fullPage:true});await app.close();app=null;
  launched=await launch();app=launched.app;page=launched.page;await settle(page);farm=await farmOf(page);state=await stateOf(page);
  assert(farm.totals.quantity===182&&farm.totals.estimatedValue===119000&&farm.prices.find(value=>value.itemId===501).unitPrice===650,'Restart preserves verified receipt quantities and all shared prices without duplication');
  assert(state.expansion.finance.events.length===1&&state.expansion.finance.events[0].quantity===999999,'The old manual ledger is preserved but never becomes automatic bag income');
  await grow(0,[cardReceived(501,1),cardReceived(777777,3,9),status(5,10000)]);await wait(page,async()=>{const value=(await window.midgard.getState()).expansion.autoFarm;return value.items.find(item=>item.itemId===501)?.quantity===181&&value.items.find(item=>item.itemId===777777)?.quantity===3;});farm=await farmOf(page);
  assert(farm.totals.knownValue===119650&&farm.totals.estimatedValue===null&&farm.totals.unpricedItems===1,'After restart a new known item inherits its price and a new unknown ID waits for one');
  assert(!errors.length,'No renderer errors occur');
  const report={passed:checks.length,checks,errors,fixture:'Synthetic inventory lists, delta packets and legacy finance rows only. No real player data copied.',limits:'Packet-profile automation is tested. Real Skadi client compatibility and physical speaker output are not established by these generated fixtures.'};await writeFile(path.join(output,'auto-farm-ui-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));
}catch(error){await writeFile(path.join(output,'auto-farm-ui-failure.json'),JSON.stringify({checks,errors,failure:String(error)},null,2));try{await(await app?.firstWindow())?.screenshot({path:path.join(output,'failure.png'),fullPage:true});}catch{}throw error;}finally{await app?.close();}
