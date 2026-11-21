import { Coins, Heart, MapPin, PackageOpen, Weight } from 'lucide-react';
import { liveStatusPresentation } from '../domain/live-presentation';
import { isLiveSourceActive, liveHealthPercent, type LiveWorkspaceRow } from '../domain/live-workspace';
import { liveAppearanceForCharacter } from '../shared/live-appearance';
import type { LiveViewPreferences } from '../shared/live-view';
import { LIVE_CHARACTER_ART } from './live-adventure-assets';
import ReplayExperience from './ReplayExperience';
import crest from '../assets/live/pixel-party/crest.webp';

const number = new Intl.NumberFormat('tr-TR', {maximumFractionDigits:1});
const percent = (value: number | null | undefined) => value == null ? '—' : `%${number.format(value)}`;

interface PartyRowProps {
  row: LiveWorkspaceRow;
  view: LiveViewPreferences;
  itemNames: ReadonlyMap<number, string>;
}

export default function TaskbarPartyRow({row, view, itemNames}: PartyRowProps) {
  const {stream, name} = row;
  const telemetry = stream.summary?.liveTelemetry;
  const status = liveStatusPresentation(stream);
  const map = telemetry?.currentMap || stream.summary?.mapName;
  const hp = liveHealthPercent(stream);
  const weight = telemetry?.weightPercent;
  const weightDetail = telemetry?.weight != null && telemetry.maxWeight != null && telemetry.maxWeight > 0
    ? `${number.format(telemetry.weight / 10)} / ${number.format(telemetry.maxWeight / 10)}` : '';
  const appearance = liveAppearanceForCharacter(view.appearanceByCharacter, row.key);
  const loot = stream.recentLoot ?? (stream.lastLoot ? {
    pickupCount: 1, totalQuantity: stream.lastLoot.quantity, items:[stream.lastLoot],
  } : undefined);
  const today = stream.dailyLoot;
  const received = telemetry?.zenyReceived;
  const balance = telemetry?.zenyBalance;
  const zenyDetail = received == null ? 'Replay’de gelir ölçümü için cüzdan hareketi bekleniyor.' :
    `Gösterilen Replay’de gözlenen cüzdan artışları toplamı +${number.format(received)} Zeny.`;
  return <article className="taskbar-party-row" aria-label={name} data-character-key={row.key} data-stream-id={stream.id}>
    <div className="taskbar-party-member">
      <div className="taskbar-strip-scene" aria-hidden="true">
        <img src={appearance ? LIVE_CHARACTER_ART[appearance] : crest} alt="" draggable={false}
          data-active={!!appearance && !!stream.summary && isLiveSourceActive(stream)}/>
      </div>
      <div className="taskbar-strip-identity">
        <strong title={name}>{name}</strong>
        {map && <span className="taskbar-strip-map" title={map}><MapPin size={10} aria-hidden="true"/><span>{map}</span></span>}
        <span className="taskbar-strip-source" data-tone={status.tone} title={`${status.description} · ${stream.filename}`}><i/>{status.label}</span>
      </div>
    </div>
    <div className="taskbar-party-vitals" aria-label="Can ve ağırlık">
      <div className="taskbar-meter taskbar-strip-hp" title={`Can · ${percent(hp)}`}>
        <Heart size={13} aria-hidden="true"/><span className="taskbar-meter-track">{hp != null &&
          <meter min={0} max={100} value={hp} aria-label={`${name} can`}/>}</span><b>{percent(hp)}</b>
      </div>
      <div className="taskbar-meter taskbar-strip-weight" data-warning={weight != null && weight >= row.threshold}
        title={`Ağırlık · ${weightDetail || percent(weight)} · Uyarı eşiği %${row.threshold}`}>
        <Weight size={13} aria-hidden="true"/><span className="taskbar-meter-track">{weight != null &&
          <meter min={0} max={100} value={Math.max(0, Math.min(100, weight))} aria-label={`${name} ağırlık`} aria-valuetext={`${percent(weight)} · ${weightDetail}`}/>}</span><b>{percent(weight)}</b>
      </div>
      {weightDetail && <small className="taskbar-weight-load" title="Taşınan ağırlık / taşıma kapasitesi">{weightDetail}</small>}
    </div>
    <div className="taskbar-strip-loot" aria-label="Son 3 ganimet ve günlük adetleri">
      <small className="taskbar-mobile-label">Son 3 ganimet</small>
      {loot?.items.length ? <ul>{loot.items.map(item => {
        const label = itemNames.get(item.itemId) ?? `Eşya #${item.itemId}`;
        const quantity = today?.itemQuantities[item.itemId];
        const dailyDetail = quantity == null ? 'Günlük adet bekleniyor' : `Bugün ${number.format(quantity)} adet`;
        return <li key={item.itemId} className="taskbar-loot-item"
          title={`${label} · ${dailyDetail} · Son ${loot.pickupCount} alımda ${number.format(item.quantity)} adet`}>
          <strong>{label}</strong><b>{quantity == null ? '—' : `×${number.format(quantity)}`}</b>
        </li>;
      })}</ul> : <span className="taskbar-loot-empty"><PackageOpen size={12} aria-hidden="true"/>Bekleniyor</span>}
      <span className="taskbar-loot-total" title="Bu karakterin bugün tüm eşyalardan topladığı doğrulanmış ganimet adedi (Türkiye saati)">
        <small>Bugün</small><b>{today ? number.format(today.totalQuantity) : '—'}</b>
      </span>
    </div>
    <div className="taskbar-strip-zeny" aria-label="Gelen Zeny"
      title={`${zenyDetail}${balance == null ? '' : ` Son bakiye ${number.format(balance)} Zeny.`}`}>
      <small className="taskbar-mobile-label">Gelen Zeny</small>
      <strong className="taskbar-zeny-value"><Coins size={13} aria-hidden="true"/><span>{received == null ? '—' : `+${number.format(received)}`}</span></strong>
      {balance != null && <small className="taskbar-zeny-balance" title={`Cüzdan ${number.format(balance)} Zeny`}>Cüzdan {number.format(balance)}</small>}
    </div>
    <ReplayExperience key={`${stream.id}/${stream.summary?.startedAt ?? ''}`} compact telemetry={telemetry}/>
  </article>;
}
