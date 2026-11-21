import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {AlertAudio} from '../src/domain/alert-audio';
import {createDefaultAlertPreferences} from '../src/domain/notifications';
import {usesSelectedItemSound} from '../src/domain/alert-targets';
class Context {
  static current:Context;state='running';currentTime=0;destination={};oscillators:{frequency:{value:number};type:string;starts:number}[]=[];buffers:{starts:number}[]=[];gains:{gain:{value:number}}[]=[];
  constructor(){Context.current=this;}
  resume(){this.state='running';return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}
  createGain(){const node={gain:{value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};this.gains.push(node);return node;}
  createOscillator(){const source={frequency:{value:0},type:'',starts:0,onended:null as null|(()=>void),connect(){},disconnect(){},start(){source.starts++;},stop(){}};this.oscillators.push(source);return source;}
  createBufferSource(){const source={buffer:null as unknown,starts:0,onended:null as null|(()=>void),connect(){},disconnect(){},start(){source.starts++;},stop(){}};this.buffers.push(source);return source;}
  decodeAudioData(){return Promise.resolve({duration:.1});}
}
beforeEach(()=>vi.stubGlobal('AudioContext',Context));afterEach(()=>vi.unstubAllGlobals());
describe('kart ve kostüm sesleri', () => {
  const override = {category:'card',itemId:4317} as const;
  const selected = {name:'drop.wav',dataUrl:'data:audio/wav;base64,AQIDBA=='};
  it('yalnız etkin eski hedefe atanmış dosyayı özel ve genel seçimlerden sonra kullanır',async () => {
    const audio = new AlertAudio();
    const readLegacy = vi.fn(async()=>selected);
    const noSound = async()=>null;
    await audio.notifyRare(override,createDefaultAlertPreferences,noSound,undefined,readLegacy);
    expect(readLegacy).toHaveBeenCalledOnce();
    expect(Context.current.buffers).toHaveLength(1);
    expect(Context.current.oscillators).toHaveLength(0);
    const categorySound = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(selected);
    await audio.notifyRare(override,createDefaultAlertPreferences,categorySound,undefined,readLegacy);
    expect(categorySound.mock.calls).toEqual([[override],[{category:'card'}]]);
    expect(readLegacy).toHaveBeenCalledTimes(1);
    expect(Context.current.buffers).toHaveLength(2);
    await audio.setSound('card',selected);
    await audio.notifyRare({...override,itemId:4999},createDefaultAlertPreferences,noSound);
    expect(Context.current.buffers).toHaveLength(2);
    expect(Context.current.oscillators).toHaveLength(4);
    await audio.notifyRare({category:'costume',itemId:1000},createDefaultAlertPreferences,noSound);
    expect(Context.current.buffers).toHaveLength(2);
    expect(Context.current.oscillators).toHaveLength(8);
    await audio.notifyRare(override,createDefaultAlertPreferences,noSound,undefined,readLegacy);
    expect(readLegacy).toHaveBeenCalledTimes(1);
    expect(Context.current.buffers).toHaveLength(3);
    audio.dispose();
  });
  it('karakter ve ortak hedefleri mevcut etkin bildirim kuralıyla eşler',()=>{
    const global = {...createDefaultAlertPreferences(),selectedCardIds:[4317]};
    const local = {...global,selectedCardIds:[9000]};
    expect(usesSelectedItemSound(4317,local,global)).toBe(true);
    expect(usesSelectedItemSound(9000,local,global)).toBe(true);
    expect(usesSelectedItemSound(9999,local,global)).toBe(false);
    expect(usesSelectedItemSound(4317,{...local,enabled:{...local.enabled,card:false}},global)).toBe(false);
    expect(usesSelectedItemSound(4317,local,{...global,enabled:{...global.enabled,card:false}})).toBe(false);
    expect(usesSelectedItemSound(603,{...global,selectedCardIds:[603]},global)).toBe(false);
  });
  it('özel ses varken aynı alım için yalnızca onu çalar',async () => {
    const audio = new AlertAudio();
    const read = vi.fn(async () => selected);
    expect(await audio.notifyRare(override, createDefaultAlertPreferences,read)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(override);
    expect(Context.current.buffers).toHaveLength(1);
    expect(Context.current.oscillators).toHaveLength(0);
    audio.dispose();
  });
  it('eksik özel dosyada aynı kategorinin genel sesini bir kez çalar',async () => {
    const audio = new AlertAudio();
    const fallback = vi.fn(), read = vi.fn().mockRejectedValueOnce(new Error('eksik')).mockResolvedValueOnce(selected);
    expect(await audio.notifyRare(override,createDefaultAlertPreferences,read,fallback)).toBe(true);
    expect(read.mock.calls).toEqual([[override],[{category:'card'}]]);
    expect(fallback).toHaveBeenCalledOnce();
    expect(Context.current.buffers).toHaveLength(1);
    audio.dispose();
  });
  it('kart ve kostüm için ayrı varsayılan ton çalar, hatalı genel ses olayları engellemez',async () => {
    const audio = new AlertAudio();
    await audio.setSound('card',selected);
    const read = vi.fn().mockResolvedValue({name:'bad.wav',dataUrl:'invalid'});
    const fallback = vi.fn();
    await audio.notifyRare({category:'costume'},createDefaultAlertPreferences,read,fallback);
    expect(fallback).toHaveBeenCalledOnce();
    const costumeNotes = Context.current.oscillators.map(node=>node.frequency.value);
    await audio.notifyRare({category:'card'},createDefaultAlertPreferences, async()=>null);
    const cardNotes = Context.current.oscillators.slice(costumeNotes.length).map(node=>node.frequency.value);
    expect(costumeNotes).toHaveLength(4);
    expect(cardNotes).toHaveLength(4);
    expect(cardNotes).not.toEqual(costumeNotes);
    expect(Context.current.buffers).toHaveLength(0);
    expect(audio.play('card',createDefaultAlertPreferences())).toBe(true);
    expect(Context.current.buffers).toHaveLength(1);
    audio.dispose();
  });
  it('sessiz mod veya sıfır seste dosya açmaz ve yüklenirken değişen sessizliği uygular',async () => {
    const audio = new AlertAudio();
    const prefs = createDefaultAlertPreferences(), read = vi.fn(async () => selected);
    expect(await audio.notifyRare(override,()=>({...prefs,muted:true}),read)).toBe(false);
    expect(await audio.notifyRare(override,()=>({...prefs,volume:0}),read)).toBe(false);
    expect(read).not.toHaveBeenCalled();
    read.mockImplementationOnce(async()=>{prefs.muted=true;return selected;});
    expect(await audio.notifyRare(override,()=>prefs,read)).toBe(false);
    expect(Context.current.buffers).toHaveLength(0);
    audio.dispose();
  });
});
describe('monster alert audio',()=>{
  it('plays a short distinct default tone for monster observations',async()=>{const audio=new AlertAudio();await audio.enable();expect(audio.play('monster',createDefaultAlertPreferences())).toBe(true);expect(Context.current.oscillators.map(source=>source.frequency.value)).toEqual([784,587,784]);expect(Context.current.oscillators.every(source=>source.starts===1)).toBe(true);audio.dispose();});
  it('respects readiness, global mute and volume zero',async()=>{const audio=new AlertAudio(),prefs=createDefaultAlertPreferences();expect(audio.play('monster',prefs)).toBe(false);await audio.enable();expect(audio.play('monster',{...prefs,muted:true})).toBe(false);expect(audio.play('monster',{...prefs,volume:0})).toBe(false);expect(Context.current.oscillators).toHaveLength(0);audio.dispose();});
  it('uses a selected monster sound independently of the existing card tone',async()=>{const audio=new AlertAudio();await audio.enable();await audio.setSound('monster',{name:'monster.wav',dataUrl:'data:audio/wav;base64,AQIDBA=='});expect(audio.play('monster',createDefaultAlertPreferences())).toBe(true);expect(Context.current.buffers[0].starts).toBe(1);expect(Context.current.oscillators).toHaveLength(0);expect(audio.play('card',createDefaultAlertPreferences())).toBe(true);expect(Context.current.oscillators.map(source=>source.frequency.value)).toEqual([659,831,988,1319]);audio.dispose();});
});

describe('Glass Bead alert audio',()=>{
  it('uses the MIDGARD item tone when Glass Bead has no custom sound',async()=>{
    const audio=new AlertAudio();await audio.enable();
    expect(audio.play('glass-bead',createDefaultAlertPreferences())).toBe(true);
    expect(Context.current.oscillators.map(s=>s.frequency.value)).toEqual([659,831,988,1319]);
    expect(Context.current.buffers).toHaveLength(0);
    audio.dispose();
  });
  it('keeps Glass Bead silent before audio is ready, while muted, or at zero volume',async()=>{
    const audio=new AlertAudio(),prefs=createDefaultAlertPreferences();
    expect(audio.play('glass-bead',prefs)).toBe(false);await audio.enable();
    expect(audio.play('glass-bead',{...prefs,muted:true})).toBe(false);
    expect(audio.play('glass-bead',{...prefs,volume:0})).toBe(false);
    expect(Context.current.oscillators).toHaveLength(0);expect(Context.current.buffers).toHaveLength(0);
    audio.dispose();
  });
  it('plays its own selected sound without replacing the existing card or monster sounds',async()=>{
    const audio=new AlertAudio();await audio.enable();
    await audio.setSound('glass-bead',{name:'user-glass-bead.wav',dataUrl:'data:audio/wav;base64,AQIDBA=='});
    expect(audio.play('glass-bead',createDefaultAlertPreferences())).toBe(true);
    expect(Context.current.buffers).toHaveLength(1);expect(Context.current.buffers[0].starts).toBe(1);
    expect(Context.current.oscillators).toHaveLength(0);
    expect(audio.play('card',createDefaultAlertPreferences())).toBe(true);
    expect(Context.current.oscillators.map(source=>source.frequency.value)).toEqual([659,831,988,1319]);
    expect(audio.play('monster',createDefaultAlertPreferences())).toBe(true);
    expect(Context.current.oscillators.slice(-3).map(source=>source.frequency.value)).toEqual([784,587,784]);
    await audio.setSound('glass-bead',null);
    expect(audio.play('glass-bead',createDefaultAlertPreferences())).toBe(true);
    expect(Context.current.oscillators.slice(-4).map(s=>s.frequency.value)).toEqual([659,831,988,1319]);
    audio.dispose();
  });
});

describe('Old Blue Box alert audio',()=>{
  it('uses the MIDGARD item tone when the box WAV is missing',async()=>{
    const audio=new AlertAudio();await audio.enable();
    expect(audio.play('old-blue-box',{...createDefaultAlertPreferences(),volume:100})).toBe(true);
    expect(Context.current.oscillators.map(s=>s.frequency.value)).toEqual([659,831,988,1319]);
    expect(Context.current.buffers).toHaveLength(0);
    audio.dispose();
  });
  it('respects readiness, global mute and volume zero for the box alert',async()=>{
    const audio=new AlertAudio(),prefs=createDefaultAlertPreferences();
    expect(audio.play('old-blue-box',prefs)).toBe(false);await audio.enable();
    expect(audio.play('old-blue-box',{...prefs,muted:true})).toBe(false);
    expect(audio.play('old-blue-box',{...prefs,volume:0})).toBe(false);
    expect(Context.current.oscillators).toHaveLength(0);expect(Context.current.buffers).toHaveLength(0);
    audio.dispose();
  });
  it('plays the decoded box sound while leaving the Glass Bead slot empty',async()=>{
    const audio=new AlertAudio();await audio.enable();
    await audio.setSound('old-blue-box',{name:'custom-box.wav',dataUrl:'data:audio/wav;base64,AQIDBA=='});
    expect(audio.play('old-blue-box',createDefaultAlertPreferences())).toBe(true);
    expect(Context.current.buffers[0].starts).toBe(1);expect(Context.current.oscillators).toHaveLength(0);
    expect(audio.play('glass-bead',createDefaultAlertPreferences())).toBe(true);
    expect(Context.current.buffers).toHaveLength(1);
    expect(Context.current.oscillators.map(s=>s.frequency.value)).toEqual([659,831,988,1319]);
    audio.dispose();
  });
});

describe('incoming notifications with an inactive audio output', () => {
  const preferences = () => createDefaultAlertPreferences();
  it('starts the output on the first notification without a gesture', async () => {
    const audio = new AlertAudio();
    expect(await audio.notify('card', preferences)).toBe(true);
    expect(Context.current.oscillators).toHaveLength(4);
    audio.dispose();
  });
  it.each(['suspended', 'interrupted'])('resumes a %s output and coalesces concurrent alerts while resuming', async state => {
    const audio = new AlertAudio();
    await audio.enable();
    const context = Context.current;
    context.state = state;
    let resume!: () => void;
    const request = vi.spyOn(context, 'resume').mockImplementation(() => new Promise<void>(resolve => {
      resume = () => { context.state = 'running'; resolve(); };
    }));
    const first = audio.notify('card', preferences);
    const duplicate = audio.notify('card', preferences);
    const independent = audio.notify('glass-bead', preferences);
    resume();
    expect(await Promise.all([first, duplicate, independent])).toEqual([true, false, true]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(context.oscillators).toHaveLength(8);
    audio.dispose();
  });
  it('rechecks mute while resuming and does not play after disposal', async () => {
    const audio = new AlertAudio();
    const prefs = preferences();
    await audio.enable();
    Context.current.state = 'suspended';
    const pending = audio.notify('card', () => prefs);
    prefs.muted = true;
    expect(await pending).toBe(false);
    expect(Context.current.oscillators).toHaveLength(0);
    audio.dispose();
    expect(await audio.notify('card', preferences)).toBe(false);
  });
  it('can retry after the device initially rejects a resume', async () => {
    const audio = new AlertAudio();
    await audio.enable();
    Context.current.state = 'suspended';
    vi.spyOn(Context.current, 'resume').mockRejectedValueOnce(new Error('device unavailable'));
    await expect(audio.notify('card', preferences)).rejects.toThrow('device unavailable');
    expect(await audio.notify('card', preferences)).toBe(true);
    audio.dispose();
  });
});
