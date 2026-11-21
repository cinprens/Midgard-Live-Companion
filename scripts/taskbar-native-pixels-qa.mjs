import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {mkdir, mkdtempDisposable, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import electronPath from 'electron';
import {chromium} from 'playwright';
import {PNG} from 'playwright-core/lib/utilsBundle';
import {seedLiveAdventure} from './live-adventure-fixtures.mjs';

// This test reads the Windows desktop only inside the unobscured client area
// of a verified temporary fixture process. CDP screenshots alone cannot prove
// that Windows is actually presenting the Chromium compositor surface.
assert.equal(process.platform,'win32');
const arg = name => process.argv.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3);
const project = fileURLToPath(new URL('..',import.meta.url));
const output = path.resolve(arg('output') ?? path.join(project,'.qa','taskbar-native-hotfix','development'));
const portable = arg('portable');
await mkdir(output,{recursive:true});
await using scratch = await mkdtempDisposable(path.join(tmpdir(),'midgard-visible-client-'));
const fixture = await seedLiveAdventure(scratch.path,{openStream:true,experience:true});
const env = {...process.env,MIDGARD_USER_DATA:fixture.profile};
delete env.ELECTRON_RUN_AS_NODE;
delete env.MIDGARD_DEV_URL;
const launchArgs = [...(portable?[]:[project]),'--remote-debugging-port=0','--mute-audio','--replace-live-sources',
  ...fixture.files.map(file=>'--live-file='+file)];
const launcher = spawn(portable?path.resolve(portable):electronPath,launchArgs,{env,windowsHide:true,stdio:'ignore'});
const closed = new Promise(resolve=>{
  launcher.once('exit',code=>resolve({code}));
  launcher.once('error',error=>resolve({error}));
});

async function waitFor(operation,label,timeout=30_000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {
    const result=await operation();
    if(result) return result;
    await delay(100);
  }
  throw new Error(label);
}

function compare(actual,reference,width,height,inset) {
  const a=PNG.sync.read(actual), b=PNG.sync.read(reference);
  assert.equal(a.width,width-2*inset);
  assert.equal(a.height,height-2*inset);
  assert.ok(Math.abs(b.width/b.height-width/height)<.02,'Renderer and native window have different aspect ratios');
  let total=0, tiles=0, salient=0, matching=0, bright=0;
  // Local 5x5 averages suppress subpixel font differences and minor scaling.
  for(let y=2;y<a.height-2;y+=5) for(let x=2;x<a.width-2;x+=5) {
    const first=[0,0,0], second=[0,0,0];
    for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++) {
      const i=((y+dy)*a.width+(x+dx))*4;
      const bx=Math.floor((x+dx+inset+.5)*b.width/width);
      const by=Math.floor((y+dy+inset+.5)*b.height/height);
      const j=(by*b.width+bx)*4;
      for(let c=0;c<3;c++) {first[c]+=a.data[i+c]/25;second[c]+=b.data[j+c]/25;}
    }
    const err=first.reduce((sum,v,c)=>sum+Math.abs(v-second[c]),0)/3;
    total+=err; tiles++;
    if(Math.max(...first)>100) bright++;
    if(Math.max(...second)>100) {salient++; if(err<35) matching++;}
  }
  const mean=total/tiles, matchingFraction=matching/Math.max(1,salient);
  return {width,height,meanError:+mean.toFixed(2),salientTiles:salient,desktopBrightTiles:bright,
    matchingFraction:+matchingFraction.toFixed(3),pass:salient>=12 && mean<18 && matchingFraction>.72};
}

const run=promisify(execFile);
const results=[];
const errors=[];
let browser,page;
try {
  const endpoint=await waitFor(async()=>{
    const raw=await readFile(path.join(fixture.profile,'DevToolsActivePort'),'utf8').catch(()=>null);
    const [port,route]=(raw??'').trim().split(/\r?\n/);
    return /^\d+$/.test(port)&&Number(port)<=65535&&/^\/devtools\/browser\/[\da-f-]+$/i.test(route)
      ? 'ws://127.0.0.1:'+port+route : null;
  },'Cannot reach owned fixture endpoint',60_000);
  browser=await chromium.connectOverCDP(endpoint);
  page=await waitFor(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>/\/dist\/index\.html/i.test(p.url())),
    'Cannot locate application content');
  page.setDefaultTimeout(12_000);
  page.on('pageerror',error=>errors.push(error.message));
  const cdp=await browser.newBrowserCDPSession();
  const {processInfo}=await cdp.send('SystemInfo.getProcessInfo');
  const pid=processInfo.find(p=>p.type==='browser')?.id;
  assert.ok(Number.isInteger(pid)&&pid>0);
  await page.waitForFunction(async()=>(await window.midgard.getState()).live?.streams.filter(s=>s.summary).length===3);
  // The fixture saves the dark theme before launch, matching the reported panel.
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  const open=page.getByRole('button',{name:'Görev çubuğu modu',exact:true});
  const dock=page.locator('.taskbar-strip');
  const back=dock.getByRole('button',{name:'Ana pencereye dön',exact:true});
  const helperArgs=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    path.join(project,'scripts','taskbar-visible-client.ps1'),'-AppProcess',String(pid)];
  const focusMain=process.argv.includes('--focus-main');
  if(focusMain) {
    const focus=await run('powershell.exe',[...helperArgs,'-FocusMain'],{windowsHide:true,timeout:12_000});
    console.log('Owned main foreground before first entry:',focus.stdout.trim());
  }
  async function check(name,background=false) {
    await page.evaluate(()=>document.fonts.ready);
    await delay(550);
    const nativeFile=path.join(output,name+'-windows.png');
    const {stdout}=await run('powershell.exe',[...helperArgs,'-OutputPng',nativeFile,...(focusMain?['-AllowUnfocused']:[]),
      ...(background?['-BehindFixture']:[])],
    {windowsHide:true,timeout:20_000});
    const {width,height,inset}=JSON.parse(stdout);
    // Deliberately after the physical capture: a Chromium screenshot can itself
    // force a compositor refresh and inadvertently mask a black native window.
    const reference=await page.screenshot({path:path.join(output,name+'-renderer.png'),animations:'disabled'});
    const result={name,...compare(await readFile(nativeFile),reference,width,height,inset)};
    results.push(result);
    console.log(JSON.stringify(result));
  }
  // On the first entry, never capture Chromium, refocus or force an initial repaint.
  await open.click();
  await dock.waitFor();
  await check('00-first-entry');
  await back.click();
  await dock.waitFor({state:'hidden'});
  await check('01-main');
  await open.click();
  await dock.waitFor();
  await check('02-horizontal');
  await dock.getByRole('button',{name:'Dikey görünüme geç',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.taskbar-strip')?.dataset.layout==='vertical' && innerWidth<=400);
  await check('03-vertical');
  await dock.locator('.party-disclosure').first().click();
  await dock.locator('.taskbar-party-detail').waitFor();
  await check('04-expanded');
  await back.click();
  await dock.waitFor({state:'hidden'});
  await check('05-restored-main');
  await open.click();
  await dock.waitFor();
  await check('06-reopened');
  await dock.getByRole('button',{name:'Yatay görünüme geç',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.taskbar-strip')?.dataset.layout==='horizontal' && innerWidth>400);
  await check('07-horizontal-again');
  assert.equal(await dock.getByRole('button',{name:'Her zaman üstte'}).getAttribute('aria-pressed'),'true');
  await check('08-pinned-background',true);
  await dock.getByRole('button',{name:'Uygulamayı kapat',exact:true}).click();
  assert.equal((await Promise.race([closed,delay(20_000,{},{ref:false})])).code,0);
  await writeFile(path.join(output,'results.json'),JSON.stringify({results,errors},null,2));
  assert.deepEqual(errors,[]);
  assert.deepEqual(results.filter(r=>!r.pass).map(r=>r.name),[],'Windows client pixels diverge from the renderer');
} catch(error) {
  console.error('Native panel run failed:',error);
  if(errors.length) console.error('Renderer errors:',errors);
  throw error;
} finally {
  if(browser?.isConnected()) {
    const session=await browser.newBrowserCDPSession().catch(()=>null);
    if(session) await Promise.race([session.send('Browser.close').catch(()=>{}),delay(1500)]);
    await Promise.race([browser.close().catch(()=>{}),delay(1500)]);
  }
  const result=await Promise.race([closed,delay(20_000,null,{ref:false})]);
  if(!result) throw new Error('Temporary test process did not close');
  if(result.error) throw result.error;
}
