import {useEffect,useRef} from 'react';
import {Check,Shield, X} from 'lucide-react';
import {LIVE_APPEARANCES,type LiveAppearanceId} from '../shared/live-appearance';
import {LIVE_CHARACTER_ART,LIVE_SCENE_ART} from './live-adventure-assets';

interface Props {
  characterName:string;
  selected:LiveAppearanceId|null;
  onSelect:(appearance:LiveAppearanceId|null)=>void;
  onClose:()=>void;
}

export default function LiveAppearancePicker({characterName,selected,onSelect,onClose}:Props){
  const dialogRef=useRef<HTMLDialogElement>(null),closeRef=useRef(onClose);closeRef.current=onClose;
  useEffect(()=>{
    const dialog=dialogRef.current,previous=document.activeElement;
    if(!dialog)return;
    dialog.showModal();
    const chosen=dialog.querySelector<HTMLButtonElement>('[data-appearance-id][aria-pressed="true"]')??dialog.querySelector<HTMLButtonElement>('[data-appearance-id]');chosen?.focus();
    return()=>{dialog.close();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};
  },[]);
  return <dialog ref={dialogRef} className="live-appearance-dialog" aria-label={`${characterName} için görünüm seç`} onCancel={event=>{event.preventDefault();closeRef.current();}} onClick={event=>{if(event.target===event.currentTarget){const rect=event.currentTarget.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)onClose();}}}>
    <header><div><span>Karakter görünümü</span><h2>{characterName}</h2></div><button type="button" aria-label="Görünüm seçimini kapat" onClick={onClose}><X size={21}/></button></header>
    <p>Bu temsili seçim yalnız MIDGARD görünümünü değiştirir. Oyundaki kıyafetin veya sınıfın değildir.</p>
    <div className="live-appearance-options">{(['feminine','masculine'] as const).map(group=><section key={group} aria-label={group==='feminine'?'Kadınsı görünümler':'Erkeksi görünümler'}><h3>{group==='feminine'?'Kadınsı görünümler':'Erkeksi görünümler'}</h3><div>{LIVE_APPEARANCES.filter(appearance=>appearance.presentation===group).map(appearance=><button type="button" key={appearance.id} data-appearance-id={appearance.id} aria-label={`${appearance.label} görünümünü seç`} aria-pressed={selected===appearance.id} onClick={()=>onSelect(appearance.id)}><span className="live-appearance-preview" style={{backgroundImage:`url(${LIVE_SCENE_ART})`}}><img src={LIVE_CHARACTER_ART[appearance.id]} alt=""/>{selected===appearance.id&&<Check size={17}/>}</span><strong>{appearance.label}</strong></button>)}</div></section>)}</div>
    <footer><button type="button" className="live-appearance-reset" onClick={()=>onSelect(null)}><Shield size={15}/>Varsayılan simge</button><small>4 kadınsı · 3 erkeksi görünüm</small></footer>
  </dialog>;
}
