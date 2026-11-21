import type {LiveNotification} from './notifications';
import type {RareDropEvent} from '../shared/rare-drop';
import type {SceneKind} from '../shared/scene-durations';

type GeneralKind = Exclude<SceneKind, 'card'|'costume'>;
export type GeneralTaskbarScene = LiveNotification & {category: GeneralKind};
export type TaskbarScene = RareDropEvent | GeneralTaskbarScene;

/** Only the primary alert stream represents General Rules. A sound preview has no game event. */
export function generalTaskbarScene(event: LiveNotification, characterKey?: string): GeneralTaskbarScene | null {
  if (event.streamId === 'sound-test' || event.type === 'level' || event.type === 'glass-bead') return null;
  const category = event.type === 'card' || event.type === 'old-blue-box' ? 'item' : event.type;
  return {...event, characterKey: event.characterKey ?? characterKey, category};
}
