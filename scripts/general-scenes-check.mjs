import assert from 'node:assert/strict';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {mapChange,ownDeath,status} from './assistance-fixtures.mjs';
import {mobDeath} from './kill-count-fixtures.mjs';
import {adventureNames,adventurePlayers} from './live-adventure-fixtures.mjs';
import {wait} from './qa-wait.mjs';

export async function checkGeneralScenes(page,fixture,append,output){
  const durations={item:3,monster:2,weight:2,city:1,death:1,card:2,costume:3};
  const names={item:'Eşya',monster:'Yaratık ölümü',weight:'Çanta ağırlığı',city:'Harita değişimi',death:'Karakter ölümü',card:'Kartlar',costume:'Kostümler'};
  await page.getByRole('button',{name:'Bildirim ayarları',exact:true}).click();
  assert.deepEqual(await page.getByRole('switch').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')).sort()),Object.values(names).slice(0,5).sort());
  for(const [kind,seconds] of Object.entries(durations)){
    const label=names[kind],input=page.getByRole('spinbutton',{name:label+' sahne süresi (saniye)',exact:true});
    if(!await input.isVisible())await page.locator('.notice-disclosure').filter({has:page.getByText(label,{exact:true})}).click();
    assert.equal(await input.inputValue(),'5');
    await input.fill(String(seconds));
    await page.getByRole('button',{name:label+' süresini kaydet',exact:true}).click();
    await wait(page,async({kind,seconds})=>(await window.midgard.getState()).assistance.sceneDurations[kind]===seconds,{kind,seconds});
  }
  const db=new DatabaseSync(fixture.database,{readOnly:true});
  try{assert.deepEqual(JSON.parse(db.prepare("SELECT value_json FROM expansion_settings WHERE key='taskbar-scene-durations'").get().value_json),durations);}finally{db.close();}
  await page.reload();
  await page.getByRole('navigation',{name:'Ana gezinme'}).waitFor();
  await page.getByRole('button',{name:'Bildirim ayarları',exact:true}).click();
  await page.locator('.notice-disclosure').filter({has:page.getByText(names.weight,{exact:true})}).click();
  assert.equal(await page.getByRole('spinbutton',{name:names.weight+' sahne süresi (saniye)',exact:true}).inputValue(),'2');
  await page.getByRole('heading',{name:'Genel kurallar',exact:true}).locator('../..').screenshot({path:path.join(output,'Genel-Kurallar.png')});
  await page.evaluate(async()=>{
    await window.midgard.setAlertPreferences({selectedCardIds:[999999,4255],weightThreshold:65,cityMaps:['prontera'],selectedMonsterIds:[1313],muted:true});
  });
  await fixture.append(0,[mapChange('gef_fild10')],720000);
  await page.getByRole('button',{name:'Görev çubuğu modu',exact:true}).click();
  const board=page.getByRole('main',{name:'Görev çubuğu modu'});await board.waitFor();
  await page.evaluate(()=>{
    window.generalSceneLog=[];window.notified=[];window.generalAudioCount=0;
    window.midgard.onNotification(event=>window.notified.push(event.type));
    window.midgard.onRareDrop(event=>window.notified.push('rare-'+event.category));
    for(const source of [AudioBufferSourceNode,OscillatorNode]){
      const start=source.prototype.start;
      source.prototype.start=function(...args){window.generalAudioCount++;return start.apply(this,args);};
    }
    let last;
    new MutationObserver(()=>{
      const node=document.querySelector('.taskbar-drop-scene'),id=node?.dataset.dropId;
      if(last===id)return;
      if(last)window.generalSceneLog.at(-1).end=performance.now();
      if(id)window.generalSceneLog.push({kind:node.dataset.category,character:node.querySelector('.drop-fighter-name strong')?.textContent,
        text:node.textContent,start:performance.now()});
      last=id;
    }).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-drop-id']});
  });
  async function receipt(eventType,send){
    const before=await page.evaluate(type=>window.notified.filter(v=>v===type).length,eventType);
    await send();
    await wait(page,({eventType,before})=>window.notified.filter(v=>v===eventType).length>before,{eventType,before},{timeout:10000});
  }
  await receipt('card',()=>append('ordinary',1,47,999999,17410,731000));
  const item=board.locator('.taskbar-drop-scene[data-category="item"]');
  await item.waitFor();await delay(350);await board.screenshot({path:path.join(output,'Esya-Sahnesi.png')});
  await receipt('weight',()=>fixture.append(2,[status(24,76000)],733000));
  await Promise.all([
    (async()=>{
      await board.locator('.taskbar-drop-scene[data-category="weight"]').waitFor();await delay(300);
      await board.screenshot({path:path.join(output,'Agirlik-Sahnesi.png')});
    })(),
    (async()=>{
      await receipt('city',()=>fixture.append(0,[mapChange('prontera')],734000));
      await receipt('monster',()=>fixture.append(1,mobDeath(45001,1313,'Mobster',adventurePlayers[1]),735000));
      await receipt('death',()=>fixture.append(2,[ownDeath(adventurePlayers[2])],736000));
      await receipt('rare-card',()=>append('card',0,46,4255,12920,737000));
      await receipt('rare-costume',()=>append('costume',1,48,5915,17420,738000));
    })(),
  ]);
  await wait(page,()=>window.generalSceneLog.length>=7&&!!window.generalSceneLog.at(-1).end,null,{timeout:30000});
  const result=await page.evaluate(()=>({scenes:window.generalSceneLog,audio:window.generalAudioCount}));
  const expected=['item','weight','city','monster','death','card','costume'];
  assert.deepEqual(result.scenes.map(s=>s.kind),expected);
  assert.deepEqual(result.scenes.map(s=>s.character),[1,2,0,1,2,0,1].map(i=>adventureNames[i]));
  for(const [i,token] of ['999999|QA Eşya','76','prontera','Mobster','öl','Orc Lady Card',"Angel's Veil"].entries())assert.match(result.scenes[i].text,new RegExp(token,'i'));
  assert.equal(result.audio,0,'Muted rules display a scene and keep audio silent');
  for(const s of result.scenes){const elapsed=s.end-s.start;assert.ok(elapsed>=durations[s.kind]*1000-100&&elapsed<=durations[s.kind]*1000+700,s.kind+' visible for '+elapsed);}
  await page.evaluate(async()=>{
    await window.midgard.setAlertPreferences({muted:false,volume:65,selectedCardIds:[746]});
    window.generalSamples=[];
    const start=AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start=function(...args){
      window.generalSamples.push({duration:this.buffer?.duration,when:performance.now()});
      return start.apply(this,args);
    };
  });
  await fixture.append(0,[mapChange('gef_fild10')],742000);
  await receipt('card',()=>append('ordinary',1,49,746,17430,744000));
  await receipt('city',()=>fixture.append(0,[mapChange('prontera')],746000));
  await wait(page,()=>window.generalSceneLog.length>=9&&!!window.generalSceneLog.at(-1).end);
  const audible=await page.evaluate(()=>({scenes:window.generalSceneLog.slice(7),samples:window.generalSamples,starts:window.generalAudioCount}));
  assert.deepEqual(audible.scenes.map(s=>s.kind),['item','city']);
  assert.match(audible.scenes[0].text,/Glass Bead/);
  assert.deepEqual(audible.samples.map(s=>Math.round(s.duration*100)),[22,36]);
  assert.equal(audible.starts,2);
  audible.samples.forEach((s,i)=>assert.ok(Math.abs(s.when-audible.scenes[i].start)<700));
  return result.scenes.map(s=>[s.kind,Math.round(s.end-s.start)]);
}
