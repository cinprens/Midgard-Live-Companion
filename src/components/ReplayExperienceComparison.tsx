import {useEffect, useRef, useState} from 'react';
import type {AppState} from '../shared/types';
import type {ReplayComparisonResult} from '../domain/replay-experience-comparison';
import './ReplayExperienceComparison.css';

const amounts = new Intl.NumberFormat('tr-TR',{signDisplay:'exceptZero'});
const dates = new Intl.DateTimeFormat('tr-TR',{
  year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'UTC',
});
const dateLabel = (embedded: string) => dates.format(new Date(embedded+'Z'));
const format = (value: number | null) => value === null ? '—' : amounts.format(value);
function message(error: unknown) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Replay karşılaştırması açılamadı.';
}

export function useTrackedReplayExperience(state:AppState) {
  const api = typeof window === 'undefined' ? undefined : window.midgard?.compareReplayExperience;
  const [saved,setSaved] = useState<{scope:string; result:ReplayComparisonResult|null; error:string}|null>(null);
  const [refresh,setRefresh] = useState(0);
  const queue = useRef(Promise.resolve());
  const scope = state.settings.replayFolder ?? '';
  const discovery = state.live?.discovery;
  // A new recording matters. Incoming packets within the same recording cannot change its starting balance.
  const sourceKey = JSON.stringify([discovery?.candidateCount, discovery?.recordingsRevision, discovery?.blockedReason,
    state.live?.streams.map(s=>[s.id,s.sourcePath,s.summary?.startedAt]).sort()]);
  useEffect(()=>{
    if (!api) return;
    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    function enqueue(attempt:number) {
      const scan = async () => {
        if (!current) return;
        try {
          const result = await api!('tracked');
          if (!current) return;
          setSaved({scope,result,error:''});
          if (result?.unreadable && attempt < 2) retry = setTimeout(() => enqueue(attempt + 1), attempt ? 6000 : 2000);
        } catch(reason) {
          if (current) setSaved(previous=>({scope,result:previous?.scope===scope?previous.result:null,error:message(reason)}));
        }
      };
      queue.current = queue.current.then(scan,scan);
    }
    enqueue(0);
    return ()=>{current=false;clearTimeout(retry);};
  },[api,scope,sourceKey,refresh]);
  return {tracked:saved?.scope===scope?saved.result:null, trackedError:saved?.scope===scope?saved.error:'', refreshTracked: () => setRefresh(n => n + 1)};
}

export default function ReplayExperienceComparison({tracked,trackedError,refreshTracked}: ReturnType<typeof useTrackedReplayExperience>) {
  const api = typeof window === 'undefined' ? undefined : window.midgard?.compareReplayExperience;
  const [chosen,setChosen] = useState<ReplayComparisonResult|null>(null);
  const [choosing,setChoosing] = useState(false);
  const [error,setError] = useState('');
  if (!api) return null;
  async function choose() {
    if (!api || choosing) return;
    setChoosing(true);
    setError('');
    try {const result = await api('choose'); if(result)setChosen(result);}
    catch(reason) {setError(message(reason));}
    finally {setChoosing(false);}
  }
  const result = chosen ?? tracked;
  const intervals = result?.intervals;
  return <section className="replay-exp-reading replay-exp-comparison" aria-label="İki Replay arasında net EXP">
    <h3>İki Replay arasında net EXP</h3>
    {intervals?.map((row,i)=><div className="replay-exp-interval" key={row.characterKey+row.after.startedAt+i}>
      <strong>{row.character}</strong>
      <p><time dateTime={row.before.startedAt} title={row.before.filename}>{dateLabel(row.before.startedAt)}</time>
        {' → '}<time dateTime={row.after.startedAt} title={row.after.filename}>{dateLabel(row.after.startedAt)}</time></p>
      <dl><div><dt>Base</dt><dd>{format(row.base)}</dd></div><div><dt>Job</dt><dd>{format(row.job)}</dd></div></dl>
      {(row.base===null || row.job===null) && <p>— Bu ölçüm için uyumlu seviye ve EXP bilgisi eksik.</p>}
    </div>)}
    {result && !intervals?.length && <p>Aynı karaktere ait farklı başlangıç saatli iki Replay bekleniyor.</p>}
    {!result && !trackedError && <p>Replay başlangıçları okunuyor…</p>}
    {!!intervals?.length && <p>İki kayıt başlangıcı arasındaki bakiye farkı. Aradaki tüm kazanım ve kayıpları kapsar.</p>}
    {!!result?.unreadable && <p>{result.unreadable} Replay başlangıcı okunamadı.</p>}
    {(error || (!chosen && trackedError)) && <p role="alert">{error || trackedError}</p>}
    <div className="replay-exp-actions">
      <button type="button" disabled={choosing} onClick={()=>void choose()}>İki Replay seç</button>
      <button type="button" disabled={choosing} onClick={()=>{setChosen(null);setError('');refreshTracked();}}>
        {chosen ? 'Takip edilenlere dön' : 'Yenile'}
      </button>
    </div>
  </section>;
}
