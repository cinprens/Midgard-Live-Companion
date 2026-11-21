import { useEffect,useState } from 'react';
import { BellRing,RotateCcw,Save } from 'lucide-react';
import { defaultCharacterAlerts,type CharacterAlertPreferences } from '../domain/expansion-alerts';
import type { AlertPreferences } from '../shared/types';
import type {RareSoundCategory} from '../shared/rare-drop-sounds';
import {GENERAL_ALERT_RULES} from './general-alert-rules';
import type { AlertPreferencesPatch } from '../domain/notifications';
const visibleExpandedKinds=['valuable-item','item-value','hourly-goal'] as const;
const expandedLabels:Record<typeof visibleExpandedKinds[number],string>={'valuable-item':'Değerlenen eşya kazanıldı','item-value':'Eşya değeri eşiğe ulaştı','hourly-goal':'Saatlik kazanç hedefe ulaştı'};

export function characterLegacyForSave(draft:AlertPreferencesPatch,saved:AlertPreferencesPatch|undefined):AlertPreferencesPatch{
  const result={...draft};if(!Object.prototype.hasOwnProperty.call(saved??{},'selectedMonsterIds'))delete result.selectedMonsterIds;return result;
}
export default function CharacterAlertSettings({characters,saved,global,busy,onSave,rareCategories}:{rareCategories:ReadonlyMap<number,RareSoundCategory>;characters:{key:string;name:string}[];saved:Record<string,CharacterAlertPreferences>;global:AlertPreferences;busy:boolean;onSave:(key:string,config:CharacterAlertPreferences|null)=>Promise<void>}){
  const[key,setKey]=useState(characters[0]?.key??''),[draft,setDraft]=useState(defaultCharacterAlerts()),[cardDraft,setCardDraft]=useState<string|null>(null),[error,setError]=useState('');
  const savedValue=JSON.stringify(saved[key]??null);
  useEffect(()=>{if(!characters.some(character=>character.key===key))setKey(characters[0]?.key??'');},[characters,key]);
  useEffect(()=>{const value=saved[key]?structuredClone(saved[key]):defaultCharacterAlerts();setDraft(value);setCardDraft(null);setError('');},[key,savedValue]);
  const legacy=draft.legacy,enabled={...global.enabled,...legacy.enabled};
  const oldIds=legacy.selectedCardIds??[];
  const cards=cardDraft??oldIds.filter(id=>!rareCategories.has(id)).join(', ');
  async function save(){
    const ids=cards.split(/[,\s]+/).filter(Boolean).map(Number);
    if(ids.some(id=>!Number.isSafeInteger(id)||id<=0||id>0xffffffff)){setError('Eşya kimlikleri pozitif tam sayılar olmalı.');return;}
    if(cardDraft!==null&&ids.some(id=>rareCategories.has(id))){setError('Kart ve kostüm seslerini yukarıdaki Kart ve kostüm sesleri bölümünden seçebilirsin.');return;}
    setError('');
    const selectedCardIds=[...new Set([...oldIds.filter(id=>rareCategories.has(id)),...ids])];
    await onSave(key,{...draft,legacy:characterLegacyForSave({...legacy,...(cardDraft!==null&&{selectedCardIds})},saved[key]?.legacy)});
  }
  return <section className="character-alert-preferences"><div className="character-alert-heading"><BellRing size={21}/><div><h2>Karaktere özel bildirimler</h2><p>Bu karakter için olayları, eşikleri ve ses düzeyini seç.</p></div><select aria-label="Bildirim karakteri" value={key} onChange={e=>setKey(e.target.value)}>{!characters.length&&<option value="">Önce bir karakter ekle</option>}{characters.map(character=><option key={character.key} value={character.key}>{character.name}</option>)}</select></div>
    {key&&<><div className="character-alert-legacy">{GENERAL_ALERT_RULES.map(({kind,name})=><label key={kind}><input type="checkbox" checked={enabled[kind]} onChange={e=>setDraft({...draft,legacy:{...legacy,enabled:{...legacy.enabled,[kind]:e.target.checked}}})}/>{name}</label>)}</div><div className="character-alert-fields"><label>Ağırlık eşiği %<input aria-label="Karakter ağırlık eşiği" type="number" min="1" max="100" value={legacy.weightThreshold??global.weightThreshold} onChange={e=>setDraft({...draft,legacy:{...legacy,weightThreshold:Number(e.target.value)}})}/></label><label>Ses düzeyi %<input type="number" min="0" max="100" value={legacy.volume??global.volume} onChange={e=>setDraft({...draft,legacy:{...legacy,volume:Number(e.target.value)}})}/></label><label className="character-alert-check"><input type="checkbox" checked={legacy.muted??global.muted} onChange={e=>setDraft({...draft,legacy:{...legacy,muted:e.target.checked}})}/>Bu karakteri sessize al</label><label>Bu karaktere ek eşya kimlikleri<input aria-label="Bu karaktere ek eşya kimlikleri" placeholder="Ör. 501, 972" value={cards} onChange={e=>setCardDraft(e.target.value)}/></label></div>
    <label className="character-alert-check"><input type="checkbox" checked={enabled['old-blue-box']} onChange={e=>setDraft({...draft,legacy:{...legacy,enabled:{...legacy.enabled,'old-blue-box':e.target.checked}}})}/>Old Blue Box</label>
    <div className="character-alert-expanded">{visibleExpandedKinds.map(kind=><label key={kind}><input type="checkbox" checked={draft.enabled[kind]} onChange={e=>setDraft({...draft,enabled:{...draft.enabled,[kind]:e.target.checked}})}/><span>{expandedLabels[kind]}<small>Eşya sesi kullanılır</small></span></label>)}</div>
    <div className="character-alert-fields"><label>Eşya değeri eşiği · Zeny<input aria-label="Eşya değer uyarı eşiği" type="number" min="0" value={draft.itemValueThreshold} onChange={e=>setDraft({...draft,itemValueThreshold:Number(e.target.value)})}/></label><label>Saatlik net hedef · Zeny<input aria-label="Saatlik kazanç hedefi" type="number" min="0" value={draft.hourlyGoal} onChange={e=>setDraft({...draft,hourlyGoal:Number(e.target.value)})}/></label><label>Tekrar bekleme · saniye<input type="number" min="1" max="86400" value={draft.cooldownSeconds} onChange={e=>setDraft({...draft,cooldownSeconds:Number(e.target.value)})}/></label></div>
    {error&&<p className="assistant-warning" role="alert">{error}</p>}<div className="character-alert-actions"><button className="button primary" disabled={busy} onClick={()=>void save()}><Save size={15}/> Karakter ayarlarını uygula</button><button className="button secondary" disabled={busy} onClick={()=>void onSave(key,null)}><RotateCcw size={15}/> Genel ayarlara dön</button><small>Genel sessiz mod bütün karakterler için geçerlidir.</small></div></>}
  </section>;
}
