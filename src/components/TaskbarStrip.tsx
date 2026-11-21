import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, BellRing, Coins, ExternalLink, Package, Pin, PinOff, RectangleHorizontal, RectangleVertical, Settings2, Swords, UserRound, UsersRound, Volume2, VolumeX, X } from 'lucide-react';
import { createDefaultAlertPreferences } from '../domain/notifications';
import {serviceMessage} from '../i18n/catalog';
import { buildTaskbarPartyRows, isTaskbarSourceLive, taskbarPartyReading, taskbarPartyTotals } from '../domain/taskbar-party';
import { taskbarHuntCount } from '../domain/taskbar-hunt';
import type { LiveViewPreferences } from '../shared/live-view';
import type { AppState, LiveNotification, TaskbarOptions } from '../shared/types';
import type { TaskbarScene } from '../domain/taskbar-scenes';
import { liveAppearanceForCharacter } from '../shared/live-appearance';
import TaskbarDropScene from './TaskbarDropScene';
import TaskbarPartyRow from './TaskbarPartyRow';
import { taskbarEstimateHint, taskbarEstimateText } from './taskbar-estimate';
import './TaskbarStrip.css';
import {useLanguage} from '../i18n/language';

export function useTaskbarMode() {
  const api = window.midgard;
  const available = typeof api?.setTaskbarMode === 'function' && typeof api.getTaskbarMode === 'function';
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState(available);
  const [error, setError] = useState('');
  const changing = useRef(false);

  useEffect(() => {
    if (!available) return;
    let alive = true;
    void api!.getTaskbarMode().then(value => {
      if (alive) setActive(value);
    }).catch(() => {
      if (alive) setError('Pencere modu okunamadı. Görev çubuğu modunu yeniden seçebilirsin.');
    }).finally(() => { if (alive) setPending(false); });
    return () => { alive = false; };
  }, [available, api]);

  async function change(next: boolean) {
    if (!available || pending || changing.current) return;
    changing.current = true;
    setPending(true);
    setError('');
    try {
      setActive(await api!.setTaskbarMode(next));
    } catch (reason) {
      // A native error can occur after resizing. Read the actual mode before showing the message.
      try { setActive(await api!.getTaskbarMode()); } catch { /* Retain the last confirmed mode. */ }
      setError(reason instanceof Error ? reason.message : 'Pencere modu değiştirilemedi.');
    } finally {
      changing.current = false;
      setPending(false);
    }
  }
  return { active, available, pending, error, change };
}

interface TaskbarStripProps {
  state: AppState;
  view: LiveViewPreferences;
  pending: boolean;
  error: string;
  notification?: LiveNotification;
  scene?: TaskbarScene | null;
  audioReady?: boolean;
  audioBusy?: boolean;
  onAudioToggle?: () => void;
  onSettings: () => void;
  onExit: () => void;
}

const defaultPreferences = createDefaultAlertPreferences();
const format = new Intl.NumberFormat('tr-TR');

function useDockControls() {
  const [options, setOptions] = useState<TaskbarOptions>({pinned: true, orientation: 'horizontal'});
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const working = useRef(false);
  useEffect(() => {
    let mounted = true;
    const api = window.midgard;
    if (!api) return;
    void api.getTaskbarOptions().then(value => {
      if (mounted) setOptions(value);
    }).catch(() => {
      if (mounted) setError('Panel tercihleri okunamadı.');
    }).finally(() => { if (mounted) setBusy(false); });
    return () => { mounted = false; };
  }, []);

  async function run(action: 'pin' | 'orientation' | 'close') {
    const api = window.midgard;
    if (!api || working.current || busy) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      if (action === 'close') await api.closeTaskbar();
      else {
        const patch: Partial<TaskbarOptions> = action === 'pin' ? {pinned: !options.pinned} :
          {orientation: options.orientation === 'horizontal' ? 'vertical' : 'horizontal'};
        setOptions(await api.setTaskbarOptions(patch));
      }
    } catch {
      setError(action === 'close' ? 'Uygulama kapatılamadı. Yeniden deneyebilirsin.' : 'Panel tercihi uygulanamadı. Yeniden deneyebilirsin.');
      try { setOptions(await api.getTaskbarOptions()); } catch { /* Keep the last confirmed window state. */ }
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  return {options, busy, error, run};
}

export default function TaskbarStrip({ state, view, pending, error, notification, scene, audioReady, audioBusy, onAudioToggle, onSettings, onExit }: TaskbarStripProps) {
  const language = useLanguage();
  const dock = useDockControls();
  const vertical = dock.options.orientation === 'vertical';
  const controlsBusy = pending || dock.busy;
  const layoutAction = vertical ? 'Yatay görünüme geç' : 'Dikey görünüme geç';
  const preferences = state.assistance?.preferences ?? defaultPreferences;
  const rows = useMemo(() => buildTaskbarPartyRows(state, preferences, view.sourcePath), [state, preferences, view.sourcePath]);
  const readings = useMemo(() => rows.map(taskbarPartyReading), [rows]);
  const totals = useMemo(() => taskbarPartyTotals(rows, readings), [rows, readings]);
  const catalog = state.expansion?.autoFarm?.items;
  const itemNames = useMemo(() => new Map(catalog?.map(item => [item.itemId, item.itemName])), [catalog]);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const initialKey = rows.find(row => row.key === view.characterKey)?.key ?? rows[0]?.key;
  const selectedKey = rows.some(row => row.key === selection) ? selection : initialKey;
  const expandedIndex = rows.findIndex(row => row.key === expandedKey);
  const character = rows[expandedIndex];
  const expanded = character?.key ?? null;
  const scopeRows = useMemo(() => character ? [character] : rows, [character, rows]);
  const scope = readings[expandedIndex] ?? totals;
  const heading = character?.name ?? 'Av Ekibi';
  const hunt = useMemo(() => taskbarHuntCount(scopeRows), [scopeRows]);
  const liveCount = scopeRows.filter(row => isTaskbarSourceLive(row.stream)).length;
  const sourceLabel = liveCount ? (character ? 'Canlı' : `${liveCount} canlı`) : scopeRows.length ? (character ? 'Son okuma' : 'Son okumalar') : 'Kayıt bekleniyor';
  const lootPartial = !character && scope.lootTotal != null && readings.some(value => value.lootTotal == null);
  const roster = useRef<HTMLElement>(null);
  const strip = useRef<HTMLElement>(null);
  const exit = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLElement>(null);
  const sceneOwner = scene?.characterKey ?? (scene && rows.find(row => row.streams.some(source => source.id === scene.streamId))?.key);
  const soundOn = !preferences.muted && preferences.volume > 0 && audioReady === true;
  const soundAction = soundOn ? 'Bildirim sesini kapat' : preferences.volume === 0 ? 'Bildirim sesini %50 ile aç' : 'Bildirim sesini aç';
  const sender = notification?.character || state.live?.streams.find(source => source.id === notification?.streamId)?.filename || 'Bilinmeyen kaynak';
  const {message: replayMessage} = notification ?? {};
  const senderPrefix = `${sender}: `;
  const message = serviceMessage(replayMessage?.startsWith(senderPrefix) ? replayMessage.slice(senderPrefix.length) : replayMessage);

  useLayoutEffect(() => {
    const setHeight = window.midgard?.setTaskbarDetailHeight;
    if (!setHeight) return;
    const detail = expanded ? roster.current?.querySelector<HTMLElement>('.taskbar-party-detail') : null;
    const bar = header.current;
    let lastHeight = -1;
    const update = () => {
      const extraHeader = Math.max(0, (bar?.getBoundingClientRect().height ?? 36) - 36);
      const height = Math.ceil((detail?.getBoundingClientRect().height ?? 0) + extraHeader);
      if (lastHeight !== height) {
        lastHeight = height;
        void setHeight(height).catch(() => { /* The roster remains scrollable if resizing is unavailable. */ });
      }
    };
    update();
    const observer = new ResizeObserver(update);
    if (detail) observer.observe(detail);
    if (bar) observer.observe(bar);
    return () => observer.disconnect();
  }, [expanded, vertical]);

  useEffect(() => { if (!pending) exit.current?.focus({ preventScroll: true }); }, [pending]);
  useEffect(() => {
    function handleOutsideKey(event: KeyboardEvent) {
      if (event.target instanceof Node && strip.current?.contains(event.target)) return;
      event.stopPropagation();
      if (event.key === 'Escape' && !pending) { event.preventDefault(); onExit(); }
    }
    window.addEventListener('keydown', handleOutsideKey, true);
    return () => window.removeEventListener('keydown', handleOutsideKey, true);
  }, [onExit, pending]);

  function toggle(key: string) {
    setSelection(key);
    setExpandedKey(previous => previous === key ? null : key);
  }
  return <main ref={strip} className="taskbar-strip" data-layout={dock.options.orientation} aria-label="Görev çubuğu modu" lang={language} tabIndex={-1}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape' && !pending) { event.preventDefault(); onExit(); }
    }}>
    <header ref={header} className="taskbar-party-bar">
      <div className="taskbar-brand" aria-label="MIDGARD LIVE"><Swords size={16} aria-hidden="true"/><span>MIDGARD <b>LIVE</b></span></div>
      <div className="taskbar-party-title" data-scope={character ? 'character' : 'team'}>
        {character ? <UserRound size={16} aria-hidden="true"/> : <UsersRound size={16} aria-hidden="true"/>}
        <h1 title={heading}>{heading}</h1>{!character && <span className="party-count" title={`${rows.length} karakter`}><b>{rows.length}</b><span> karakter</span></span>}
      </div>
      <span className="party-connection" data-live={liveCount > 0} title={sourceLabel} aria-label={sourceLabel}><i/>{sourceLabel}</span>
      <div className="taskbar-strip-notice" role="status" aria-live="polite" aria-atomic="true">
        {!scene && notification && <><BellRing size={12}/><span title={`${sender} · ${message}`}><b>{sender}</b> · {message}</span></>}
      </div>
      <div className="party-metrics" role="group" aria-label={`${heading} · Bugünkü değerler`}>
        <div className="taskbar-party-wallet party-metric" data-partial={scope.estimatePartial} title={taskbarEstimateHint(scope.estimatedLootZeny, scope.estimatePartial)}>
          <Coins size={16} aria-hidden="true"/><div><small>Bugün · Tahmini Zeny</small><strong>{taskbarEstimateText(scope.estimatedLootZeny, scope.estimatePartial)}</strong></div>
        </div>
        <div className="party-metric party-loot-metric" title={`${heading} · Bugün toplanan toplam ganimet adedi${lootPartial ? ' · Bazı karakterlerin verisi eksik' : ''}`}>
          <Package size={16} aria-hidden="true"/><div><small>Ganimet</small><strong>{scope.lootTotal == null ? '—' : format.format(scope.lootTotal)}{lootPartial && <sup>*</sup>}</strong></div>
        </div>
        <div className="party-metric party-hunt-metric" title={`${heading} · Bugün karakterin kendi hasarına göre tahmini kesim. Ekipte karakter sayaçları toplanır.${hunt.partial ? ' Bazı karakterlerin ölçümü eksik.' : ''}`}>
          <Swords size={15} aria-hidden="true"/><div><small>Av sayacı</small><strong>{hunt.count == null ? '—' : format.format(hunt.count)}{hunt.partial && hunt.count != null && <sup>*</sup>}</strong></div>
        </div>
      </div>
      <div className="party-actions">
        <button type="button" className="taskbar-pin" disabled={controlsBusy} onClick={() => void dock.run('pin')}
          aria-label="Her zaman üstte" aria-pressed={dock.options.pinned} title={dock.options.pinned ? 'Üstte tutmayı bırak' : 'Paneli her zaman üstte tut'}>
          {dock.options.pinned ? <Pin size={14} aria-hidden="true"/> : <PinOff size={14} aria-hidden="true"/>}
        </button>
        <button type="button" className="taskbar-orientation" disabled={controlsBusy} onClick={() => void dock.run('orientation')}
          aria-label={layoutAction} title={layoutAction}>{vertical ? <RectangleHorizontal size={15} aria-hidden="true"/> : <RectangleVertical size={15} aria-hidden="true"/>}</button>
        {onAudioToggle && <button type="button" className="taskbar-strip-sound" disabled={audioBusy} onClick={onAudioToggle}
          aria-pressed={soundOn} aria-label={soundAction} title={soundAction}>
          {soundOn ? <Volume2 size={15}/> : <VolumeX size={15}/>}
        </button>}
        <button type="button" className="taskbar-strip-settings" disabled={pending} onClick={onSettings} aria-label="Ayarlar" title="Bildirim ayarları"><Settings2 size={15}/></button>
        <button type="button" className="taskbar-strip-exit" ref={exit} disabled={pending} onClick={onExit} aria-label="Ana pencereye dön" title="Ana pencereye dön (Esc)"><ExternalLink size={14}/><span>Ana pencere</span></button>
        <button type="button" className="taskbar-close" disabled={controlsBusy} onClick={() => void dock.run('close')}
          aria-label="Uygulamayı kapat" title="Uygulamayı kapat"><X size={15} aria-hidden="true"/></button>
      </div>
    </header>
    {rows.length ? <>
      <div className="taskbar-party-columns" aria-hidden="true">
        <span>Karakter</span><span>Can / Ağırlık</span><span>Son ganimet <em>· günlük</em></span><span>Tahmini Zeny <em>· bugün</em></span><span>EXP <em>· kayıt boyunca</em></span><span/>
      </div>
      <section ref={roster} className="taskbar-party-roster" aria-label="Takip edilen karakterler">
        {rows.map((row, index) => <TaskbarPartyRow key={row.key} row={row} reading={readings[index]} view={view} itemNames={itemNames}
          selected={row.key === selectedKey} expanded={row.key === expanded} onToggle={() => toggle(row.key)}/>)}
      </section>
    </> : <div className="taskbar-party-empty"><AudioLines size={19}/><strong>Kayıt bekleniyor</strong><span>{state.settings.replayFolder ? 'Karakterler Replay okununca burada görünecek.' : 'Ana pencereden Replay klasörünü seç.'}</span></div>}
    {scene && <TaskbarDropScene key={scene.id} scene={scene} appearance={liveAppearanceForCharacter(view.appearanceByCharacter, sceneOwner)}/>}
    {(error || dock.error) && <span className="taskbar-strip-error" role="alert">{error || dock.error}</span>}
  </main>;
}
