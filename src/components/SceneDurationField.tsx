import {useEffect, useState} from 'react';
import {Timer} from 'lucide-react';
import {getSceneSeconds, MAX_SCENE_SECONDS, MIN_SCENE_SECONDS, type SceneDurations, type SceneKind} from '../shared/scene-durations';

export type SaveSceneDuration = (kind:SceneKind, seconds:number) => Promise<boolean>;

export default function SceneDurationField({kind, label, durations, busy, onSave}: {
  kind: SceneKind;
  label: string;
  durations?: SceneDurations;
  busy: boolean;
  onSave: SaveSceneDuration;
}) {
  const seconds = getSceneSeconds(durations, kind);
  const [draft, setDraft] = useState(String(seconds));
  useEffect(() => setDraft(String(seconds)), [seconds, kind]);
  const value = Number(draft);
  const valid = Number.isInteger(value) && value >= MIN_SCENE_SECONDS && value <= MAX_SCENE_SECONDS;
  return <form className="notice-duration" onSubmit={event => {
    event.preventDefault();
    if (valid && !busy && value !== seconds) void onSave(kind, value);
  }}>
    <label><Timer size={15} aria-hidden="true"/> Sahne süresi
      <input type="number" required min={MIN_SCENE_SECONDS} max={MAX_SCENE_SECONDS} step={1}
        aria-label={label + ' sahne süresi (saniye)'} value={draft} disabled={busy}
        onChange={event => setDraft(event.target.value)}/><span>sn</span>
    </label>
    <button className="button secondary" type="submit" aria-label={label + ' süresini kaydet'}
      disabled={busy || !valid || seconds === value}>Süreyi kaydet</button>
  </form>;
}
