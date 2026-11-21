import {useMemo, useState} from 'react';
import {ChevronDown, Layers, Play, Search, Shirt, X} from 'lucide-react';
import {parseTargetId} from '../domain/alert-targets';
import type {RareSoundSetting, RareSoundTarget, RareSoundCategory} from '../shared/rare-drop-sounds';
import type {SceneDurations} from '../shared/scene-durations';
import SceneDurationField, {type SaveSceneDuration} from './SceneDurationField';

export type RareSoundAction = 'choose' | 'test' | 'reset';
type Props = {
  choices: RareSoundSetting[];
  items: Map<number,string>;
  categories: Map<number,RareSoundCategory>;
  busy: boolean;
  silent: boolean;
  onSound: (action: RareSoundAction, target: RareSoundTarget) => void;
  durations?: SceneDurations;
  onSceneDuration: SaveSceneDuration;
  previousItemIds: number[];
  previousSound?: string;
  onRemovePrevious: (id:number) => void;
};
const labels = {card: 'Kartlar', costume: 'Kostümler'};

function CategorySounds({category, choices, items, categories, busy, silent, onSound, durations, onSceneDuration, previousItemIds, previousSound, onRemovePrevious}: Props & {category: RareSoundCategory}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const isCard = category === 'card';
  const Icon = isCard ? Layers : Shirt;
  const generalLabel = isCard ? 'Genel kart sesi' : 'Genel kostüm sesi';
  const general = choices.find(rule => rule.category === category && rule.itemId === undefined);
  const overrides = choices.filter(rule => rule.category === category && rule.itemId !== undefined);
  const options = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return [];
    const id = parseTargetId(term);
    if (id !== null) {
      const known = categories.get(id);
      if (known && known !== category) return [];
      return [[id, items.get(id) ?? `Eşya #${id}`]] as [number,string][];
    }
    const matches: [number,string][] = [];
    for (const [id, kind] of categories) {
      const name = items.get(id);
      if (kind === category && name?.toLowerCase().includes(term)) {
        matches.push([id,name]);
        if (matches.length === 6) break;
      }
    }
    return matches;
  }, [query, items, categories, category]);
  const previousIds = previousItemIds.filter(id=>categories.get(id)===category);
  function soundRow(title: string, fileName?: string, itemId?: number, previous=false) {
    const target: RareSoundTarget = itemId === undefined ? {category} : {category, itemId};
    const effectiveFile=fileName ?? (previous ? general?.fileName ?? previousSound : undefined) ?? 'Varsayılan ton';
    return <div className="rare-sound-row" key={itemId ?? category}>
      <div className="rare-sound-label"><strong>{title}</strong><small>{effectiveFile}{itemId !== undefined && ` · #${itemId}`}{previous && ' · Önceki eşya hedefi'}</small></div>
      <div className="notice-sounds">
        <button className="button secondary" disabled={busy} type="button" aria-label={`${title} için ses seç`} onClick={() => onSound('choose', target)}>Ses seç</button>
        <button className="button secondary" disabled={busy || silent} type="button" aria-label={`${title} dene`} onClick={() => onSound('test', target)}><Play size={12}/> Dene</button>
        {fileName && <button className="button secondary" disabled={busy} type="button" aria-label={`${title} ses seçimini kaldır`}
          title={itemId === undefined ? 'Varsayılan tona dön' : 'Genel sesi kullan'} onClick={() => onSound('reset', target)}><X size={13}/></button>}
        {previous && !fileName && itemId !== undefined && <button className="button secondary" disabled={busy} type="button"
          aria-label={`${title} eski eşya hedefini kaldır`} title="Eski eşya hedefini kaldır" onClick={()=>onRemovePrevious(itemId)}><X size={13}/></button>}
      </div>
    </div>;
  }
  return <section className="notice-rule rare-sound-category">
    <div className="notice-rule-row">
      <button className="notice-disclosure" type="button" aria-expanded={open} aria-controls={`rare-sounds-${category}`} onClick={() => setOpen(!open)}>
        <span className="notice-glyph"><Icon size={17}/></span><span><strong>{labels[category]}</strong><small>{general?.fileName ?? 'Varsayılan ton'}{overrides.length > 0 && ` · ${overrides.length} özel ses`}</small></span><ChevronDown size={15}/>
      </button>
    </div>
    <div id={`rare-sounds-${category}`} hidden={!open} className="notice-detail rare-sound-detail">
      <SceneDurationField kind={category} label={labels[category]} durations={durations} busy={busy} onSave={onSceneDuration}/>
      {soundRow(generalLabel, general?.fileName)}
      {overrides.map(rule => soundRow(items.get(rule.itemId!) ?? `Eşya #${rule.itemId}`, rule.fileName, rule.itemId, previousIds.includes(rule.itemId!)))}
      {previousIds.filter(id=>!overrides.some(rule=>rule.itemId===id)).map(id=>soundRow(items.get(id)??`Eşya #${id}`,undefined,id,true))}
      <label className="notice-search rare-sound-search"><Search size={15}/>
        <input type="search" aria-label={isCard ? 'Özel ses için kart ara' : 'Özel ses için kostüm ara'} maxLength={100}
          placeholder={isCard ? 'Özel ses için kart adı veya ID' : 'Özel ses için kostüm adı veya ID'} value={query} onChange={event => setQuery(event.target.value)}/>
      </label>
      {query.trim() && (options.length ? <div className="notice-options">{options.map(([id,name]) =>
        <button key={id} disabled={busy} type="button" title="Bu eşyaya ses seç" onClick={() => onSound('choose', {category,itemId:id})}>{name} <small>#{id}</small></button>)}</div>
        : <p role="status">Bu kategoride eşleşme yok. Eşyanın ID’sini de girebilirsin.</p>)}
    </div>
  </section>;
}

export default function RareDropSoundSettings(props: Props) {
  return <section className="notice-rules" aria-labelledby="rare-sound-title">
    <div className="notice-section-head"><h2 id="rare-sound-title">Kart ve kostüm sesleri</h2><span>Özel ses seçilen eşyada yalnız o ses çalar</span></div>
    <div className="notice-list"><CategorySounds {...props} category="card"/><CategorySounds {...props} category="costume"/></div>
    {props.silent && <p className="notice-hint">Ses denemek için sessiz modu kapatıp ses düzeyini yükselt.</p>}
  </section>;
}
