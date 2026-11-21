import { useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, Coins, Maximize2, UsersRound, Volume2, VolumeX } from 'lucide-react';
import { createDefaultAlertPreferences } from '../domain/notifications';
import { buildLiveWorkspaceRows } from '../domain/live-workspace';
import type { LiveViewPreferences } from '../shared/live-view';
import type { AppState, LiveNotification } from '../shared/types';
import type { TaskbarScene } from '../domain/taskbar-scenes';
import { liveAppearanceForCharacter } from '../shared/live-appearance';
import TaskbarDropScene from './TaskbarDropScene';
import TaskbarPartyRow from './TaskbarPartyRow';
import './TaskbarStrip.css';

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
  onExit: () => void;
}

const defaultPreferences = createDefaultAlertPreferences();
const format = new Intl.NumberFormat('tr-TR');

export default function TaskbarStrip({ state, view, pending, error, notification, scene, audioReady, audioBusy, onAudioToggle, onExit }: TaskbarStripProps) {
  const preferences = state.assistance?.preferences ?? defaultPreferences;
  const rows = buildLiveWorkspaceRows(state, preferences, view.sourcePath);
  const sceneOwnerKey = scene?.characterKey ?? (scene && rows.find(row => row.streams.some(stream => stream.id === scene.streamId))?.key);
  const soundOn = !preferences.muted && preferences.volume > 0 && audioReady === true;
  const soundAction = soundOn ? 'Bildirim sesini kapat' : preferences.volume === 0 ? 'Bildirim sesini %50 ile aç' : 'Bildirim sesini aç';
  const catalog = state.expansion?.autoFarm?.items;
  const itemNames = useMemo(() => new Map(catalog?.map(item => [item.itemId, item.itemName])), [catalog]);
  const known = rows.flatMap(({stream}) => {
    const amount = stream.summary?.liveTelemetry?.zenyReceived;
    return typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? [amount] : [];
  });
  const teamZeny = known.reduce((sum, value) => sum + BigInt(value), 0n);
  const partial = known.length < rows.length;
  const sender = notification?.character || state.live?.streams.find(item => item.id === notification?.streamId)?.filename || 'Bilinmeyen kaynak';
  const message = notification?.message.startsWith(`${sender}: `) ? notification.message.slice(sender.length + 2) : notification?.message;
  const exit = useRef<HTMLButtonElement>(null);
  const strip = useRef<HTMLElement>(null);
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

  return <main ref={strip} className="taskbar-strip" aria-label="Görev çubuğu modu" lang="tr" tabIndex={-1}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape' && !pending) { event.preventDefault(); onExit(); }
    }}>
    <header className="taskbar-party-bar">
      <div className="taskbar-party-title"><UsersRound size={16} aria-hidden="true"/><h1>Av ekibi</h1><span>{rows.length} karakter</span></div>
      <div className="taskbar-strip-notice" role="status" aria-live="polite" aria-atomic="true">
        {!scene && notification && <><BellRing size={13} aria-hidden="true"/><span title={`${sender} · ${message}`}><b>{sender}</b> · {message}</span></>}
      </div>
      {rows.length > 0 && <div className="taskbar-party-wallet" data-partial={partial} title={`Her karakterin gösterilen Replay’inde gözlenen pozitif bakiye değişimlerinin toplamı. ${known.length}/${rows.length} karakter için ölçüm var.${known.length ? ` Okunan toplam +${format.format(teamZeny)} Zeny.` : ''}`}>
        <Coins size={14} aria-hidden="true"/><span>{known.length > 0 && partial ? 'Kısmi toplam' : 'Ekip toplamı'}</span>
        <strong>{known.length ? `+${format.format(teamZeny)}` : '—'} Z</strong>
      </div>}
      {onAudioToggle && <button type="button" className="taskbar-strip-sound" disabled={audioBusy} onClick={onAudioToggle}
        aria-pressed={soundOn} aria-label={soundAction} title={soundOn ? `Genel bildirim sesi %${preferences.volume} · Kapat` : soundAction}>
        {soundOn ? <Volume2 size={14} aria-hidden="true"/> : <VolumeX size={14} aria-hidden="true"/>}
      </button>}
      <button type="button" className="taskbar-strip-exit" ref={exit} onClick={onExit} disabled={pending}
        aria-label="Ana pencereye dön" title="Ana pencereye dön (Esc)"><Maximize2 size={14} aria-hidden="true"/><span>Ana pencere</span></button>
    </header>
    {rows.length ? <>
      <div className="taskbar-party-columns" aria-hidden="true">
        <span>Karakter</span><span>Can ve ağırlık</span><span>Son 3 ganimet · günlük adet</span><span>Gelen Zeny</span><span>Deneyim</span>
      </div>
      <section className="taskbar-party-roster" aria-label="Takip edilen karakterler" tabIndex={0}>
        {rows.map(row => <TaskbarPartyRow key={row.key} row={row} view={view} itemNames={itemNames}/>)}
      </section>
    </> : <div className="taskbar-party-empty"><strong>Kayıt bekleniyor</strong><span>{state.settings.replayFolder ?
      'Karakterler Replay okununca burada görünecek.' : 'Ana pencereden Replay klasörünü seç.'}</span></div>}
    {scene && <TaskbarDropScene key={scene.id} scene={scene} appearance={liveAppearanceForCharacter(view.appearanceByCharacter, sceneOwnerKey)}/>}
    {error && <span className="taskbar-strip-error" role="alert">{error}</span>}
  </main>;
}
