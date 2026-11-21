import { useEffect, useState } from 'react';
import { Link2, RotateCcw } from 'lucide-react';
import type { CharacterIdentity, ManualCharacterInput } from '../shared/types';
export default function CharacterBinding({ identity, choices=[], disabled=false, onSave }: { identity?:CharacterIdentity; choices?:CharacterIdentity[]; disabled?:boolean; onSave:(value:ManualCharacterInput|null)=>void }) {
  const [name,setName]=useState(identity?.source==='manual'?identity.name:''),[key,setKey]=useState('');
  useEffect(()=>{setName(identity?.source==='manual'?identity.name:'');setKey('');},[identity?.key,identity?.name,identity?.source]);
  const unique=[...new Map(choices.filter(c=>c.source==='manual').map(c=>[c.key,c])).values()];
  return <div className="character-binding"><div className="binding-label"><Link2 size={13}/><span>Karakter eşleştirme <small>{identity?.source==='recorded'?'Kayıttan belirlendi':identity?.source==='manual'?'Manuel gruplama':'Kimlik bekleniyor'}</small></span></div><div className="binding-controls">
    {unique.length>0&&<select aria-label="Mevcut karakter" value={key} disabled={disabled} onChange={e=>{setKey(e.target.value);const found=unique.find(c=>c.key===e.target.value);setName(found?.name??'');}}><option value="">Yeni eşleştirme</option>{unique.map(c=><option key={c.key} value={c.key}>{c.name}</option>)}</select>}
    <input aria-label="Manuel karakter adı" maxLength={80} placeholder={identity?.source==='recorded'?identity.name:'Karakter adını gir…'} value={name} disabled={disabled} onChange={e=>{setName(e.target.value);setKey('');}}/>
    <button className="button secondary" disabled={disabled||!name.trim()} onClick={()=>onSave({name:name.trim(),...(key?{key}:{})})}>Eşleştir</button>
    {identity?.source==='manual'&&<button className="button icon-button" disabled={disabled} aria-label="Manuel eşleştirmeyi kaldır" onClick={()=>onSave(null)}><RotateCcw size={14}/></button>}
  </div><p>Bu isim kayıtta olmayan oyuncu kimliğini veya ganimet sahipliğini kanıtlamaz.</p></div>;
}
