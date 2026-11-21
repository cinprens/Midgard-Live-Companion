import { useId } from 'react';
import { ChevronDown, Coins, FileText, Heart, PackageOpen, Weight } from 'lucide-react';
import { liveStatusPresentation } from '../domain/live-presentation';
import { liveHealthPercent, type LiveWorkspaceRow } from '../domain/live-workspace';
import { isTaskbarSourceLive, type taskbarPartyReading } from '../domain/taskbar-party';
import { liveAppearanceForCharacter } from '../shared/live-appearance';
import type { LiveViewPreferences } from '../shared/live-view';
import { LIVE_CHARACTER_ART } from './live-adventure-assets';
import ReplayExperience from './ReplayExperience';
import { taskbarEstimateHint, taskbarEstimateText, taskbarShortEstimate } from './taskbar-estimate';
import crest from '../assets/live/pixel-party/crest.webp';

const number = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });
const clock = new Intl.DateTimeFormat('tr-TR', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'});
const fmt = (value: number | null | undefined) => value == null ? '—' : number.format(value);
const gain = (value: number | null) => value == null ? '—' : `+${number.format(value)}`;
const pair = (current: number | null | undefined, max: number | null | undefined, unit = 1) =>
  `${fmt(current == null ? null : current / unit)} / ${fmt(max == null ? null : max / unit)}`;

interface PartyRowProps {
  row: LiveWorkspaceRow;
  reading: ReturnType<typeof taskbarPartyReading>;
  view: LiveViewPreferences;
  itemNames: ReadonlyMap<number, string>;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
}

function Vital({ kind, value, detail, warning }: {kind: 'hp' | 'weight'; value?: number | null; detail: string; warning?: boolean}) {
  const health = kind === 'hp';
  const label = health ? 'Can' : 'Ağırlık';
  const pct = value == null ? '—' : `%${number.format(value)}`;
  return <div className={`taskbar-meter taskbar-strip-${kind}`} data-warning={warning} title={`${label} · ${pct} · ${detail}`}>
    {health ? <Heart size={12} aria-hidden="true"/> : <Weight size={12} aria-hidden="true"/>}
    <div className="taskbar-meter-body"><div><b>{pct}</b><small className={health ? 'taskbar-hp-load' : 'taskbar-weight-load'}>{detail}</small></div>
      <span className="taskbar-meter-track">{value != null && <meter min={0} max={100} value={Math.max(0, Math.min(100, value))}
        aria-label={label} aria-valuetext={`${pct} · ${detail}`}/>}</span>
    </div>
  </div>;
}

export default function TaskbarPartyRow({row, reading, view, itemNames, selected, expanded, onToggle}: PartyRowProps) {
  const {stream, name} = row;
  const telemetry = stream.summary?.liveTelemetry;
  const live = isTaskbarSourceLive(stream);
  const status = liveStatusPresentation(stream);
  const map = telemetry?.currentMap || stream.summary?.mapName;
  const appearance = liveAppearanceForCharacter(view.appearanceByCharacter, row.key);
  const detailId = useId();
  const itemName = (id: number) => itemNames.get(id) ?? `Eşya #${id}`;
  const lastRead = reading.lastReadAt ? new Date(reading.lastReadAt) : null;
  const estimate = taskbarEstimateText(reading.estimatedLootZeny, reading.estimatePartial);
  const estimateHint = taskbarEstimateHint(reading.estimatedLootZeny, reading.estimatePartial);
  return <article className="taskbar-party-row" aria-label={name} data-character-key={row.key} data-stream-id={stream.id} data-selected={selected}>
    <div className="taskbar-party-summary" onClick={onToggle}>
      <div className="taskbar-party-member">
        <div className="taskbar-strip-scene" aria-hidden="true"><img src={appearance ? LIVE_CHARACTER_ART[appearance] : crest} alt="" draggable={false}/></div>
        <div className="taskbar-strip-identity">
          <strong title={name}>{name}</strong>
          <span className="taskbar-recording" title={stream.sourcePath}><FileText size={10}/><span>{stream.filename}</span></span>
          <span className="taskbar-strip-source" data-tone={live ? 'active' : status.tone === 'active' ? 'waiting' : status.tone} title={status.description}><i/>{live ? 'Canlı' : status.label}</span>
        </div>
      </div>
      <div className="taskbar-party-vitals">
        <Vital kind="hp" value={liveHealthPercent(stream)} detail={pair(telemetry?.hp, telemetry?.maxHp)}/>
        <Vital kind="weight" value={telemetry?.weightPercent} detail={pair(telemetry?.weight, telemetry?.maxWeight, 10)}
          warning={telemetry?.weightPercent != null && telemetry.weightPercent >= row.threshold}/>
      </div>
      <div className="taskbar-strip-loot" aria-label="Son üç ganimet ve günlük adetleri">
        <small className="taskbar-mobile-label">Son ganimet</small>
        {reading.recentLoot.length ? <ul>{reading.recentLoot.map(item => <li key={item.itemId} className="taskbar-loot-item"
          title={`${itemName(item.itemId)} · Bugün ${fmt(item.quantity)} adet`}>
          <i aria-hidden="true"/><strong>{itemName(item.itemId)}</strong><b>×{fmt(item.quantity)}</b>
        </li>)}</ul> : <span className="taskbar-loot-empty"><PackageOpen size={12}/>{reading.lootTotal === 0 ? 'Henüz ganimet yok' :
          reading.lootTotal != null ? `Bugün ${fmt(reading.lootTotal)} adet` : 'Veri bekleniyor'}</span>}
      </div>
      <div className="taskbar-strip-zeny" aria-label="Zeny">
        <small className="taskbar-mobile-label">Tahmini Zeny</small>
        <div className="taskbar-zeny-value" title={`${estimate} · ${estimateHint}`}><Coins size={13}/><strong data-short={taskbarShortEstimate(reading.estimatedLootZeny, reading.estimatePartial)}>{estimate}</strong></div>
        <small className="taskbar-zeny-balance" title={`Son cüzdan bakiyesi · ${fmt(reading.wallet)} Zeny`}>Cüzdan <b>{fmt(reading.wallet)}</b></small>
      </div>
      <div className="taskbar-exp" aria-label="Kayıt boyunca gözlenen EXP kazanımı">
        <small className="taskbar-vertical-label">Kayıt EXP</small>
        {(['Base', 'Job'] as const).map(kind => {
          const base = kind === 'Base';
          const level = base ? reading.baseLevel : reading.jobLevel;
          const amount = base ? reading.baseGain : reading.jobGain;
          return <div key={kind} title={`${kind} seviye ${fmt(level)} · Kayıt boyunca okunan EXP kazancı ${gain(amount)}`}>
            <span>{kind} <b>{fmt(level)}</b></span><strong>{gain(amount)}</strong>
          </div>;
        })}
      </div>
      <button type="button" className="party-disclosure" aria-label={`${name} ayrıntılarını ${expanded ? 'kapat' : 'aç'}`}
        aria-expanded={expanded} aria-controls={detailId} onClick={event => {event.stopPropagation(); onToggle();}}><ChevronDown size={15} aria-hidden="true"/></button>
    </div>
    {expanded && <section className="taskbar-party-detail" id={detailId} aria-label={`${name} ayrıntıları`}>
      <div className="party-detail-loot"><h3>Günlük ganimet <span className="taskbar-loot-total"><b>{fmt(reading.lootTotal)}</b> adet</span></h3>
        {reading.dailyLoot?.length ? <ul tabIndex={0} aria-label="Günlük ganimet listesi">{reading.dailyLoot.map(item => <li key={item.itemId}><span title={itemName(item.itemId)}>{itemName(item.itemId)}</span><b>×{fmt(item.quantity)}</b></li>)}</ul>
          : <p>{reading.dailyLoot == null ? 'Günlük veri bekleniyor.' : 'Bugün ganimet kaydedilmedi.'}</p>}
      </div>
      <div className="party-detail-wallet"><h3>Zeny</h3><dl>
        <dt title={estimateHint}>Ganimet tahmini</dt><dd title={estimateHint}>{estimate}</dd>
        <dt>Bugün gelen</dt><dd>{gain(reading.zenyToday)}</dd><dt>Bu kayıtta gelen</dt><dd>{gain(reading.recordingZeny)}</dd>
        <dt>Cüzdan</dt><dd>{fmt(reading.wallet)}</dd>
      </dl>{reading.estimatePartial && <p>{reading.estimatedLootZeny == null ? 'Birim fiyatlar Finans’ta girilebilir.' : '* Fiyatı bilinen ganimetler.'}</p>}</div>
      <ReplayExperience telemetry={telemetry}/>
      <div className="party-detail-source"><h3>Replay</h3><p title={stream.filename}>{stream.filename}</p>
        {map && <p title={map}>{map}</p>}
        <small>Son başarılı okuma</small><time dateTime={reading.lastReadAt ?? undefined}>{lastRead && Number.isFinite(lastRead.getTime()) ? clock.format(lastRead) : '—'}</time>
        {reading.lootPerHour != null && <p>Ganimet / izleme saati <b>{fmt(reading.lootPerHour)}</b></p>}
      </div>
    </section>}
  </article>;
}
