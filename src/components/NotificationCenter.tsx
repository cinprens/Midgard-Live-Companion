import {useEffect, useMemo, useState, type ReactNode} from 'react';
import {ChevronDown, Play, SlidersHorizontal, Users, Volume2, VolumeX, X} from 'lucide-react';
import type {AlertKind, AlertPreferences, AlertPreferencesPatch} from '../domain/notifications';
import {itemAlertKind, selectedItemIds, targetPatch, type AlertTarget, type AlertTargetNames} from '../domain/alert-targets';
import type {AppState} from '../shared/types';
import AlertQuickAdd from './AlertQuickAdd';
import RareDropSoundSettings, {type RareSoundAction} from './RareDropSoundSettings';
import type {RareSoundCategory, RareSoundTarget} from '../shared/rare-drop-sounds';
import SceneDurationField, {type SaveSceneDuration} from './SceneDurationField';
import {GENERAL_ALERT_RULES} from './general-alert-rules';
import './NotificationCenter.css';

type Kind = typeof GENERAL_ALERT_RULES[number]['kind'];
interface Props {
  state: AppState;
  characters: {key: string; name: string}[];
  prefs: AlertPreferences;
  busy: boolean;
  audioReady: boolean;
  onAudioToggle: () => void;
  onSave: (patch: AlertPreferencesPatch) => Promise<boolean>;
  onSound: (kind: AlertKind, preset?: boolean) => void;
  onTest: (kind: AlertKind) => void;
  onRareSound: (action: RareSoundAction, target: RareSoundTarget) => void;
  onSceneDuration: SaveSceneDuration;
  children: (categories: ReadonlyMap<number, RareSoundCategory>) => ReactNode;
}
const basicNames: AlertTargetNames = {
  items: [[4317, 'Mobster Card'], [603, 'Old Blue Box'], [746, 'Glass Bead']],
  monsters: [[1313, 'Mobster']],
};

function summarize(names: string[], noun: string) {
  if (!names.length) return `Henüz ${noun} seçilmedi`;
  return names.slice(0, 2).join(', ') + (names.length > 2 ? ` · +${names.length - 2} ${noun}` : '');
}

export default function NotificationCenter({state, characters, prefs, busy, audioReady, onAudioToggle, onSave, onSound, onTest, onRareSound, onSceneDuration, children}: Props) {
  const [local, setLocal] = useState<AlertTargetNames>({items: [], monsters: []});
  const [lookupError, setLookupError] = useState('');
  const [expanded, setExpanded] = useState<Kind | null>(null);
  const [volume, setVolume] = useState(prefs.volume);
  const [threshold, setThreshold] = useState(String(prefs.weightThreshold));
  const [mapDraft, setMapDraft] = useState(prefs.cityMaps.join(', '));
  const [characterOpen, setCharacterOpen] = useState(false);
  const mapText = prefs.cityMaps.join(', ');
  useEffect(() => {setVolume(prefs.volume);}, [prefs.volume]);
  useEffect(() => {setThreshold(String(prefs.weightThreshold));}, [prefs.weightThreshold]);
  useEffect(() => {setMapDraft(mapText);}, [mapText]);
  useEffect(() => {
    let active = true;
    window.midgard?.getAlertTargetNames().then(names => {if (active) {setLocal(names); setLookupError('');}})
      .catch(() => {if (active) setLookupError('Yerel isim listesi okunamadı. Hedefi ID ile ekleyebilirsin.');});
    return () => {active = false;};
  }, [state.live?.discovery.folder, state.live?.streams.length, state.expansion?.catalog?.versions]);
  const farm = state.expansion?.autoFarm, kills = state.expansion?.killCount;
  const rareCategories = useMemo(() => {
    const categories = new Map<number,RareSoundCategory>([[4317,'card'], ...(local.rareItems ?? [])]);
    for (const item of farm?.items ?? []) {
      if (item.rareCategory) categories.set(item.itemId,item.rareCategory);
    }
    return categories;
  }, [local, farm?.revision]);
  const items = useMemo(() => {
    const names = new Map([...basicNames.items, ...local.items]);
    for (const item of farm?.items ?? []) if (!names.has(item.itemId) || !/^Eşya #\d+$/i.test(item.itemName)) names.set(item.itemId, item.itemName);
    return names;
  }, [local, farm?.revision]);
  const monsters = useMemo(() => {
    const names = new Map([...basicNames.monsters, ...local.monsters]);
    for (const mob of kills?.monsters ?? []) if (!names.has(mob.monsterId) || !/^(?:Canavar|Yaratık) #\d+$/i.test(mob.monsterName)) names.set(mob.monsterId, mob.monsterName);
    return names;
  }, [local, kills?.revision]);
  const mapKeys = [...new Set([...prefs.cityMaps, ...(state.live?.streams ?? []).map(stream =>
    stream.summary?.liveTelemetry?.currentMap ?? stream.summary?.mapName).filter((value): value is string => !!value).map(value => value.toLowerCase().replace(/\.gat$/, ''))])].join(',');
  const knownMaps = useMemo(() => mapKeys ? mapKeys.split(',') : [], [mapKeys]);
  const itemIds = selectedItemIds(prefs).filter(id => itemAlertKind(id) === 'card' && !rareCategories.has(id));
  const itemName = (id: number) => items.get(id) ?? `Eşya #${id}`;
  const monsterName = (id: number) => monsters.get(id) ?? `Yaratık #${id}`;
  const summary: Record<Kind, string> = {
    card: summarize([...itemIds.map(itemName), ...(prefs.enabled['old-blue-box'] ? [itemName(603)] : [])], 'eşya'),
    monster: summarize(prefs.selectedMonsterIds.map(monsterName), 'yaratık'),
    city: summarize(prefs.cityMaps, 'harita'),
    weight: `Ağırlık %${prefs.weightThreshold} olduğunda`,
    death: 'Kayıt sahibi öldüğünde',
  };
  function removeChip(target: AlertTarget, name: string) {
    return <button type="button" key={target.id} disabled={busy} aria-label={`${name} hedefini kaldır`}
      onClick={() => void onSave(targetPatch(prefs, target, false))}>{name}<X size={12}/></button>;
  }
  function soundControls(kind:AlertKind) {
    const silent=prefs.muted || prefs.volume===0;
    return <div className="notice-sounds"><span><Volume2 size={14}/>{state.assistance?.sounds[kind]?.name ?? 'MIDGARD bildirim tonu'}</span>
      <button className="button secondary" disabled={busy} type="button" onClick={() => onSound(kind)}>Ses seç</button>
      {(kind === 'old-blue-box' || kind === 'monster') && <button className="button secondary" disabled={busy} type="button" onClick={() => onSound(kind, true)}>{kind === 'monster' ? 'Mobster sesi' : 'Ganimet çanı'}</button>}
      <button type="button" className="button secondary" disabled={busy || silent} title={silent ? 'Önce sesi aç' : 'Sesi dene'} onClick={() => onTest(kind)}><Play size={13}/>Dene</button>
    </div>;
  }
  const soundOn = !prefs.muted && prefs.volume > 0 && audioReady;
  return <div className="notice-center">
    <header className="notice-heading"><div><h1>Bildirim merkezi</h1><p>Replay’de gördüğün hangi olaylardan haber almak istiyorsun?</p></div>
      <div className="notice-audio">
        <button className="button secondary" type="button" aria-pressed={soundOn} disabled={busy} onClick={onAudioToggle}>
          {soundOn ? <Volume2 size={15}/> : <VolumeX size={15}/>}
          {prefs.volume === 0 ? 'Sesi %50 ile aç' : prefs.muted ? 'Sessiz mod' : soundOn ? 'Ses açık' : 'Sesi etkinleştir'}
        </button>
        <label title="Ses düzeyi"><input type="range" aria-label="Ses düzeyi" min="0" max="100" value={volume} disabled={busy}
          onChange={event => setVolume(Number(event.target.value))}
          onPointerUp={() => {if (volume !== prefs.volume) void onSave({volume});}}
          onKeyUp={() => {if (volume !== prefs.volume) void onSave({volume});}}
          onBlur={() => {if (volume !== prefs.volume) void onSave({volume});}}/><output>%{volume}</output></label>
      </div>
    </header>
    <AlertQuickAdd prefs={prefs} items={items} rareCategories={rareCategories} monsters={monsters} maps={knownMaps} disabled={busy}
      onAdd={target => onSave(targetPatch(prefs, target, true))}/>
    {lookupError && <p role="alert">{lookupError}</p>}
    <RareDropSoundSettings choices={state.assistance?.rareDropSounds ?? []} items={items} categories={rareCategories} busy={busy}
      silent={prefs.muted || prefs.volume === 0} onSound={onRareSound} durations={state.assistance?.sceneDurations} onSceneDuration={onSceneDuration}
      previousItemIds={prefs.selectedCardIds} previousSound={prefs.enabled.card ? state.assistance?.sounds.card?.name : undefined}
      onRemovePrevious={id=>void onSave(targetPatch(prefs,{type:'item',id},false))}/>
    <section className="notice-rules" aria-labelledby="notice-rules-title">
      <div className="notice-section-head"><h2 id="notice-rules-title">Genel kurallar</h2><span>Karaktere özel tercihler önceliklidir</span></div>
      <div className="notice-list">{GENERAL_ALERT_RULES.map(({kind, scene, name, icon: Icon}) => {
        const open = expanded === kind;
        const quietCharacters = open && prefs.enabled[kind] ? characters.flatMap(({key, name}) => {
          const local = state.expansion?.alertPreferences?.[key]?.legacy;
          if (local?.enabled?.[kind] === false) return [`${name} (bildirim kapalı)`];
          if (local?.muted) return [`${name} (sessiz mod)`];
          if (local?.volume === 0) return [`${name} (ses %0)`];
          return [];
        }) : [];
        return <section className="notice-rule" key={kind}>
          <div className="notice-rule-row">
            <button className="notice-disclosure" type="button" aria-expanded={open} aria-controls={`notice-${kind}`} onClick={() => setExpanded(open ? null : kind)}>
              <span className="notice-glyph"><Icon size={17}/></span><span><strong>{name}</strong><small>{summary[kind]}</small></span><ChevronDown size={15}/>
            </button>
            <button className="notice-switch" type="button" role="switch" aria-label={name} aria-checked={prefs.enabled[kind]} disabled={busy}
              onClick={() => void onSave({enabled: {[kind]: !prefs.enabled[kind]}})}><span/></button>
          </div>
          <div id={`notice-${kind}`} hidden={!open} className="notice-detail">
            {open && <>
              {quietCharacters.length > 0 && <p>{quietCharacters.join(', ')}. Bu tercihleri karaktere özel ayarlardan değiştirebilirsin.</p>}
              {kind === 'card' && <><p>Seçtiğin eşyalar karakterinin çantasına geldiğinde haber verir.</p><div className="notice-chips">{itemIds.map(id => removeChip({type:'item', id}, itemName(id)))}</div></>}
              {kind === 'monster' && <><p>Ortak av hedefleriyle paylaşılır. Öldüren karakter kesin bilinmez.</p><div className="notice-chips">{prefs.selectedMonsterIds.map(id => removeChip({type:'monster', id}, monsterName(id)))}</div></>}
              {kind === 'weight' && <form onSubmit={event => {event.preventDefault(); void onSave({weightThreshold: Number(threshold)});}}>
                <label>Ağırlık eşiği (%) <input type="number" min="1" max="100" step="any" required value={threshold} onChange={event => setThreshold(event.target.value)}/></label>
                <button type="submit" className="button secondary" disabled={busy || Number(threshold) === prefs.weightThreshold}>Uygula</button>
              </form>}
              {kind === 'city' && <form onSubmit={event => {event.preventDefault(); void onSave({cityMaps: mapDraft.trim().split(/[,\s]+/).filter(Boolean)});}}>
                <label>Haritalar (virgülle ayır)<textarea rows={2} value={mapDraft} onChange={event => setMapDraft(event.target.value)}/></label>
                <button type="submit" className="button secondary" disabled={busy || mapDraft === mapText}>Listeyi uygula</button>
              </form>}
              <SceneDurationField kind={scene} label={name} durations={state.assistance?.sceneDurations} busy={busy} onSave={onSceneDuration}/>
              {soundControls(kind)}
              {kind === 'card' && <div className="notice-item-preset" role="group" aria-label="Old Blue Box sesi">
                <header><label><input type="checkbox" checked={prefs.enabled['old-blue-box']} disabled={busy}
                  onChange={event=>void onSave(targetPatch(prefs,{type:'item',id:603},event.target.checked))}/>Old Blue Box</label><small>#603</small></header>
                {soundControls('old-blue-box')}
              </div>}
              {kind === 'card' && itemIds.includes(746) && state.assistance?.sounds['glass-bead'] && <div className="notice-item-preset" role="group" aria-label="Glass Bead özel sesi">
                <header>Glass Bead <small>#746</small></header>{soundControls('glass-bead')}
              </div>}
            </>}
          </div>
        </section>;
      })}</div>
    </section>
    <section className="notice-characters">
      <button type="button" className="notice-characters-toggle" aria-expanded={characterOpen} aria-controls="character-alert-options" onClick={() => setCharacterOpen(!characterOpen)}>
        <Users size={17}/><strong>Karaktere özel ayarlar</strong><SlidersHorizontal size={15}/>
      </button>
      <div id="character-alert-options" hidden={!characterOpen}>{characterOpen && children(rareCategories)}</div>
    </section>
  </div>;
}
