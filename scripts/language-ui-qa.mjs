import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempDisposable, mkdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import electronPath from 'electron';
import {chromium} from 'playwright';
import {adventureNames, seedLiveAdventure} from './live-adventure-fixtures.mjs';
import {ownDeath} from './assistance-fixtures.mjs';

const portable=process.argv[2] ? path.resolve(process.argv[2]) : null;
const resultDir=path.resolve('.qa','language-ui',portable ? 'portable' : 'workspace');
await mkdir(resultDir,{recursive:true});
await using scratch=await mkdtempDisposable(path.join(tmpdir(),'midgard-language-'));
const fixture=await seedLiveAdventure(scratch.path,{experience:true,openStream:true});
const errors=[];
const untranslatedByPage=[];

async function poll(read, description) {
  const until=Date.now()+60000;
  do {
    const result=await read();
    if(result) return result;
    await delay(100);
  } while(Date.now()<until);
  throw new Error(description);
}

async function launch(run) {
  const env={...process.env,MIDGARD_USER_DATA:fixture.profile};
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MIDGARD_DEV_URL;
  const args=[...(portable ? [] : ['.']),'--mute-audio','--remote-debugging-port=0',
    '--replace-live-sources',...fixture.files.map(file=>'--live-file='+file)];
  const endpointFile=path.join(fixture.profile,'DevToolsActivePort');
  await rm(endpointFile,{force:true});
  const child=spawn(portable ?? electronPath,args,{env,windowsHide:true,stdio:'ignore'});
  let ended=false;
  const exit=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('exit',code=>{ended=true;resolve(code);});
  });
  let browser;
  try {
    browser=await poll(async()=>{
      if(ended) throw new Error('The test application closed before its window was ready.');
      const endpoint=await readFile(endpointFile,'utf8').catch(()=>'');
      const [port,route]=endpoint.trim().split(/\r?\n/);
      if(!/^\d+$/.test(port)||!/^\/devtools\/browser\/[a-f0-9-]+$/i.test(route))return;
      return chromium.connectOverCDP('ws://127.0.0.1:'+port+route,{timeout:1000}).catch(()=>null);
    },'Could not connect to the temporary profile');
    const page=await poll(()=>browser.contexts().flatMap(context=>context.pages()).find(tab=>/\/dist\/index\.html/i.test(tab.url())),
      'Application view did not open');
    page.on('pageerror',error=>errors.push(error.message));
    page.setDefaultTimeout(8000);
    await page.locator('.assistant-topbar .language-switch').waitFor();
    await page.waitForFunction(async()=>(await window.midgard.getState()).live.streams.filter(row=>row.summary).length===3);
    await run(page);
    // Exercise the real Close button so writes are flushed before the relaunch.
    if(!await page.locator('.taskbar-strip').isVisible()) await page.locator('.taskbar-launch').click();
    await page.locator('.taskbar-close').click();
    assert.equal(await Promise.race([exit,delay(20000,'timeout',{ref:false})]),0,'Clean app shutdown');
  } finally {
    if(browser?.isConnected()){
      const session=await browser.newBrowserCDPSession().catch(()=>null);
      if(session)await Promise.race([session.send('Browser.close').catch(()=>{}),delay(1500)]);
      await Promise.race([browser.close().catch(()=>{}),delay(1500)]);
    }
    if(!ended)await Promise.race([exit,delay(3000)]);
    if(!ended)child.kill();
    await Promise.race([exit,delay(3000,{ref:false})]);
  }
}

async function language(page,code){
  await page.getByRole('button',{name:code==='en'?'English':'Türkçe',exact:true}).click();
  await page.waitForFunction(async code=>document.documentElement.lang===code && await window.midgard.getLanguage()===code,code);
}
const photo=(page,name)=>page.screenshot({path:path.join(resultDir,name+'.png'),animations:'disabled'});
async function englishCoverage(area,label){
  const untranslated=await area.evaluate((root,names)=>{
    const result=new Set();
    const initials=names.map(name=>name.split(' ').map(part=>part[0]).join(''));
    function check(value){
      if(!value||value==='Türkçe'||initials.includes(value.trim()))return;
      for(const name of [...names,'QA Eşya','SYNTHETIC Korunan Defter','İpek · Çiçek','Türkiye']) value=value.split(name).join('');
      if(/[çÇğĞıİöÖşŞüÜ]/.test(value)) result.add(value.trim().slice(0,190));
    }
    const nodes=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);
    for(let node=nodes.nextNode();node;node=nodes.nextNode()){
      const el=node.nodeType===Node.TEXT_NODE?node.parentElement:node;
      if(!el?.checkVisibility({checkVisibilityCSS:true})||!el.getClientRects().length)continue;
      if(node.nodeType===Node.TEXT_NODE)check(node.textContent);
      else for(const attr of ['title','aria-label','placeholder','alt'])check(node.getAttribute(attr));
    }
    return [...result];
  },adventureNames);
  if(untranslated.length)untranslatedByPage.push({page:label,untranslated});
}

await launch(async page=>{
  const nav=page.locator('.assistant-sidebar nav');
  const switches=page.locator('.language-switch button');
  assert.deepEqual(await switches.allTextContents(),['TR','ENG']);
  assert.equal(await page.locator('html').getAttribute('lang'),'tr');
  await photo(page,'01-turkish');
  await nav.getByRole('button',{name:'Bildirim ayarları'}).click();
  const composer=page.locator('.notice-composer input');
  await composer.fill('İpek · Çiçek');
  const card=page.locator('[aria-controls="rare-sounds-card"]');
  await card.click();
  const guide=page.locator('.notice-guide details').last();
  await guide.locator('summary').click();
  await page.evaluate(()=>{window.__languagePageIdentity=document.querySelector('.notice-composer input');});
  await language(page,'en');
  await page.getByRole('heading',{name:'Notification center'}).waitFor();
  assert.equal(await page.evaluate(()=>window.__languagePageIdentity===document.querySelector('.notice-composer input')),true);
  assert.equal(await composer.inputValue(),'İpek · Çiçek');
  assert.equal(await card.getAttribute('aria-expanded'),'true');
  assert.equal(await guide.getAttribute('open'),'');
  assert.ok((await guide.innerText()).includes('Drag the panel by its header'));
  assert.ok(await page.getByRole('button',{name:'Choose a sound for Default card sound',exact:true}).isVisible());
  for(const item of await page.locator('.notice-guide details').all()){
    if(await item.getAttribute('open')===null)await item.locator('summary').click();
  }
  await page.getByRole('button',{name:'Character settings',exact:true}).click();
  await page.locator('[aria-controls="rare-sounds-costume"]').click();
  for(const kind of ['card','monster','weight','city','death']){
    await page.locator('[aria-controls="notice-'+kind+'"]').click();
    await englishCoverage(page.locator('#notice-'+kind),'General alert rule: '+kind);
  }
  await englishCoverage(page.locator('.assistant-shell'),'Notification settings and expanded guide');
  await photo(page,'02-english-settings');
  await fixture.append(0,[ownDeath(42)],720000);
  const flash=page.locator('.assistant-flash.death').last();
  await flash.getByText(adventureNames[0]+': Character died.',{exact:true}).waitFor({timeout:15000});
  await language(page,'tr');
  await flash.getByText(adventureNames[0]+': Karakter öldü.',{exact:true}).waitFor();
  await page.getByRole('heading',{name:'Bildirim merkezi'}).waitFor();
  assert.equal(await composer.inputValue(),'İpek · Çiçek');
  assert.ok((await guide.innerText()).includes('başlığını tutup sürükle'));
  assert.equal(await card.getAttribute('aria-expanded'),'true');
  await language(page,'en');
  for(const title of ['Live tracking','Finance','Kill Count','EXP gains','Notification settings']){
    const entry=nav.getByRole('button',{name:new RegExp('^'+title)});
    await entry.click();
    assert.equal(await entry.getAttribute('aria-current'),'page');
    await page.locator('.assistant-content h1').first().waitFor();
    await englishCoverage(page.locator('.assistant-shell'),title);
    if(title==='Live tracking'){
      await photo(page,'04-english-main');
      await page.locator('.assistant-topbar').screenshot({path:path.join(resultDir,'05-english-language-control.png'),animations:'disabled'});
    }
  }
  await page.getByRole('button',{name:'Taskbar mode',exact:true}).click();
  const dock=page.locator('.taskbar-strip');
  await dock.getByRole('heading',{name:'Hunting Party'}).waitFor();
  assert.deepEqual((await dock.locator('.taskbar-party-row').evaluateAll(rows=>rows.map(row=>row.getAttribute('aria-label')))).sort(),[...adventureNames].sort());
  await englishCoverage(dock,'Party panel');
  await photo(page,'03-english-party');
  await dock.locator('.party-disclosure').first().click();
  await dock.locator('.taskbar-party-detail').waitFor();
  await englishCoverage(dock,'Expanded character');
  await dock.getByRole('button',{name:'Return to main window',exact:true}).click();
  await page.getByRole('heading',{name:'Notification center'}).waitFor();
});

await launch(async page=>{
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal(await page.getByRole('button',{name:'English',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Taskbar mode',exact:true}).waitFor();
  await language(page,'tr');
  await page.getByRole('button',{name:'Görev çubuğu modu',exact:true}).waitFor();
});
assert.deepEqual(errors,[]);
assert.deepEqual(untranslatedByPage,[],'Untranslated visible UI text');
console.log('Passed: both languages, five pages, open guide and draft, party details, saved language after relaunch, clean shutdown.');
