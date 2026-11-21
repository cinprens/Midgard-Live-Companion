import {useMemo, useRef, useState, type FormEvent} from 'react';
import {Check, MapPin, PackageOpen, Plus, Search, Swords} from 'lucide-react';
import {parseTargetId, targetIsActive, type AlertTarget} from '../domain/alert-targets';
import type {AlertPreferences} from '../domain/notifications';
import type {RareSoundCategory} from '../shared/rare-drop-sounds';

type TargetType = AlertTarget['type'];
const types = {item: {label: 'Eşya', icon: PackageOpen}, monster: {label: 'Yaratık', icon: Swords}, map: {label: 'Harita', icon: MapPin}};
const hints = {
  item: 'Replay eşyanın bu karaktere geldiğini doğruladığında haber verir.',
  monster: 'Ölümü görüldüğünde haber verir. Seçimin ortak av hedeflerine de eklenir.',
  map: 'Karakter seçtiğin haritaya geçtiğinde haber verir.',
};
interface Props {
  items: ReadonlyMap<number, string>;
  rareCategories: ReadonlyMap<number, RareSoundCategory>;
  monsters: ReadonlyMap<number, string>;
  maps: string[];
  prefs: AlertPreferences;
  disabled: boolean;
  onAdd: (target: AlertTarget) => Promise<boolean>;
}

export default function AlertQuickAdd({items, rareCategories, monsters, maps, prefs, disabled, onAdd}: Props) {
  const [type, setType] = useState<TargetType>('item');
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const term = query.trim().toLowerCase();
  const id = parseTargetId(query);
  const names = type === 'monster' ? monsters : items;
  const options = useMemo(() => {
    const matches: {target: AlertTarget; name: string}[] = [];
    if (type === 'map') {
      const normalized = term.replace(/\.gat$/, '');
      if (/^[a-z0-9_@-]{1,48}$/.test(normalized)) matches.push({target: {type, id: normalized}, name: normalized});
      for (const map of maps) {
        if (map !== normalized && map.includes(normalized)) matches.push({target: {type, id: map}, name: map});
        if (matches.length >= 5) break;
      }
    } else if (id !== null) {
      if (type === 'item' && rareCategories.has(id)) return [];
      matches.push({target: {type, id}, name: names.get(id) ?? `${types[type].label} #${id}`});
    } else {
      for (const [key, name] of names) {
        if (type === 'item' && (rareCategories.has(key) || (!term && key === 746))) continue;
        const normalized = name.toLowerCase();
        if (normalized === term) matches.unshift({target: {type, id: key}, name});
        else if (matches.length < 5 && normalized.includes(term)) matches.push({target: {type, id: key}, name});
        if (!term && matches.length >= 3) break;
      }
    }
    return matches.slice(0, 5);
  }, [type, term, id, maps, names, rareCategories]);
  const rareMatch = useMemo(() => {
    if (type !== 'item' || !term || options.length) return undefined;
    if (id !== null) return rareCategories.get(id);
    for (const [key, category] of rareCategories) {
      if (items.get(key)?.toLowerCase() === term) return category;
    }
  }, [type, term, id, options, items, rareCategories]);
  const rareHint=rareMatch==='card'?'Bu kartı Kart ve kostüm sesleri → Kartlar bölümünde ayarlayabilirsin.':'Bu kostümü Kart ve kostüm sesleri → Kostümler bölümünde ayarlayabilirsin.';

  async function add(option: typeof options[number]) {
    if (targetIsActive(prefs, option.target)) {
      setMessage(`${option.name} bildirimi zaten açık.`);
      return;
    }
    if (await onAdd(option.target)) {
      setMessage(`${option.name} bildirimi açıldı.`);
      setQuery('');
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || !term) return;
    const exact = options.filter(option => option.name.toLowerCase() === term);
    const directMap = type === 'map' && options[0]?.target.id === term.replace(/\.gat$/, '');
    const chosen = exact.length === 1 ? exact[0] : (options.length === 1 || directMap) ? options[0] : null;
    if (chosen) void add(chosen);
    else setMessage(rareMatch ? rareHint : options.length ? 'Eklemek istediğin hedefi aşağıdan seç.' : 'Eşleşme bulunamadı. Geçerli bir kimlik gir.');
  }
  return <section className="notice-composer" aria-labelledby="quick-add-title">
    <div className="notice-section-head"><h2 id="quick-add-title">Hızlı bildirim ekle</h2>
      <div className="notice-segments" role="group" aria-label="Bildirim hedefi">
        {(Object.keys(types) as TargetType[]).map(key => {
          const {icon: Icon, label} = types[key];
          return <button key={key} type="button" aria-pressed={key === type} disabled={disabled} onClick={() => {
            setType(key); setQuery(''); setMessage(''); inputRef.current?.focus();
          }}><Icon size={14}/>{label}</button>;
        })}
      </div>
    </div>
    <form onSubmit={submit} className="notice-search-form">
      <label className="notice-search"><Search size={17}/><input ref={inputRef} value={query}
        aria-label={type === 'map' ? 'Harita kimliği' : `${types[type].label} adı veya kimliği`}
        placeholder={type === 'map' ? 'Harita kimliği, ör. prt_fild08' : type === 'item' ? 'Eşya adı veya ID, ör. Red Potion' : 'Yaratık adı veya ID, ör. Mobster'}
        autoComplete="off" maxLength={160} disabled={disabled} onChange={event => {setQuery(event.target.value); setMessage('');}}/></label>
      <button type="submit" className="button primary" disabled={disabled || !term}><Plus size={15}/>Ekle</button>
    </form>
    <div className="notice-options" aria-label="Önerilen hedefler">
      {options.map(option => {
        const active = targetIsActive(prefs, option.target);
        return <button key={option.target.id} disabled={disabled || active} type="button" title={active ? 'Bildirim açık' : 'Bildirimi ekle'}
          aria-label={`${option.name} ${active ? 'bildirimi açık' : 'bildirimi ekle'}`} onClick={() => void add(option)}>
          {active ? <Check size={13}/> : <Plus size={13}/>}<span>{option.name}</span>
          {type !== 'map' && !option.name.endsWith('#' + option.target.id) && <small>#{option.target.id}</small>}
        </button>;
      })}
    </div>
    <p role="status" className="notice-hint">{message || (rareMatch ? rareHint : term && !options.length ? (type === 'map' ? 'Geçerli bir harita kimliği gir.' : 'Ad bulunamadı. Sayısal kimlikle de ekleyebilirsin.') : hints[type])}</p>
  </section>;
}
