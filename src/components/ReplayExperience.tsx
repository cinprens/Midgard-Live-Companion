import {useState} from 'react';
import type { LiveTelemetry } from '../parser/types';
import './ReplayExperience.css';

const tr = new Intl.NumberFormat('tr-TR');
const short = new Intl.NumberFormat('tr-TR', {notation: 'compact', maximumFractionDigits: 1});
const percent = new Intl.NumberFormat('tr-TR', { style: 'percent', maximumFractionDigits: 2 });
const format = (value: number | null | undefined) => value == null ? '—' : tr.format(value);

export default function ReplayExperience({telemetry, compact = false}: {telemetry?: LiveTelemetry; compact?: boolean}) {
  const [showRemaining, setShowRemaining] = useState(false);
  const start = telemetry?.recordingStartExp;
  const remaining = {label: 'Başta kalan', base: start?.base && start.base.required - start.base.amount,
    job: start?.job && start.job.required - start.job.amount, description: 'Kaydın başında bir sonraki seviyeye kalan EXP.'};
  const required = {label: 'Sonraki seviye eşiği', base: start?.base?.required, job: start?.job?.required,
    description: 'Kayıt başlangıcındaki seviyeyi tamamlamak için gereken toplam EXP.'};
  const measures = [
    {label: 'Kaydedilen kazanç', base: telemetry?.baseExpGained, job: telemetry?.jobExpGained,
      description: 'Bu Replay’de karaktere ait okunan EXP ödüllerinin toplamı.'},
    {label: 'Son bakiye', base: telemetry?.currentBaseExp, job: telemetry?.currentJobExp,
      description: 'Replay akışında en son bildirilen EXP bakiyesi.'},
    {label: 'Kayıt başı', base: start?.base?.amount, job: start?.job?.amount,
      description: 'Replay başladığında karakterin seviyesinde birikmiş EXP.'},
  ];
  const available = measures.filter(row => row.base != null || row.job != null);
  const levels = {label: 'Seviye', base: telemetry?.baseLevel, job: telemetry?.jobLevel,
    description: 'Replay’de karakter için son okunan Base ve Job seviyeleri.'};
  const levelsKnown = levels.base != null || levels.job != null;
  const first = compact && showRemaining && start ? remaining : available[0] ?? (levelsKnown ? levels : undefined);
  const ratios = (['base', 'job'] as const).flatMap(kind => {
    const value = start?.[kind];
    return value ? [`${kind === 'base' ? 'Base' : 'Job'} ${percent.format(value.amount / value.required)}`] : [];
  }).join(' · ');
  if (compact) {
    const title = first ? [first.description, `Base ${format(first.base)} · Job ${format(first.job)}`,
      start && (showRemaining ? 'Önceki ölçüme dönmek için tıkla.' : 'Kayıt başında kalan EXP için tıkla.')].filter(Boolean).join(' ') : 'Seçili Replay’de okunabilen EXP miktarı bekleniyor.';
    const useStartLevels = first === remaining || first === measures[2];
    const content = <>
      <small>EXP · {first?.label ?? 'Veri bekleniyor'}</small>
      {first && <><span>Base{useStartLevels && start?.base ? ` ${start.base.level}` : ''} <b data-short={first.base != null && first.base >= 1_000_000 ? short.format(first.base) : undefined}>{format(first.base)}</b></span>
        <span>Job{useStartLevels && telemetry?.recordingStartJobLevel ? ` ${telemetry.recordingStartJobLevel}` : ''} <b data-short={first.job != null && first.job >= 1_000_000 ? short.format(first.job) : undefined}>{format(first.job)}</b></span></>}
    </>;
    return start ? <button type="button" className="taskbar-exp" title={title} aria-pressed={showRemaining}
      aria-label={title} onClick={()=>setShowRemaining(value=>!value)}>{content}</button>
      : <div className="taskbar-exp" aria-label="Replay EXP" title={title}>{content}</div>;
  }
  const rows = start ? [...available, required, remaining] : [...available];
  if (levelsKnown && (!start || levels.base !== start.base?.level || levels.job !== telemetry?.recordingStartJobLevel)) rows.push(levels);
  return <section className="replay-exp-reading" aria-label="Replay’den okunan EXP">
    <h3>Replay’den okunan EXP</h3>
    {rows.length ? <table><thead><tr><th scope="col">Ölçüm</th><th scope="col">Base</th><th scope="col">Job</th></tr></thead>
      <tbody>{start && <tr><th scope="row">Başlangıç seviyesi</th><td>{format(start.base?.level)}</td><td>{format(start.job?.level ?? telemetry?.recordingStartJobLevel)}</td></tr>}
        {rows.map(row=><tr key={row.label}><th scope="row" title={row.description}>{row.label}</th>
        <td>{format(row.base)}</td><td>{format(row.job)}</td></tr>)}</tbody></table>
      : <p>Bu kayıtta okunabilir bir EXP miktarı bekleniyor.</p>}
    {start && <p>Kayıt başlangıcı · {ratios}</p>}
    {available.length > 0 && !available.includes(measures[0]) && <p>Bu Replay’de henüz kişisel EXP ödülü okunmadı.</p>}
  </section>;
}
