export const SCENE_KINDS = ['item', 'death', 'city', 'weight', 'monster', 'card', 'costume'] as const;
export type SceneKind = typeof SCENE_KINDS[number];
export type SceneDurations = Record<SceneKind, number>;
export const MIN_SCENE_SECONDS = 1;
export const MAX_SCENE_SECONDS = 60;
export const DEFAULT_SCENE_SECONDS = 5;

function validSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_SCENE_SECONDS && value <= MAX_SCENE_SECONDS;
}

export function getSceneSeconds(durations: Partial<SceneDurations> | undefined, kind: SceneKind): number {
  const value = durations?.[kind];
  return validSeconds(value) ? value : DEFAULT_SCENE_SECONDS;
}

/** A missing or invalid saved field affects only that scene. */
export function readSceneDurations(saved: unknown): SceneDurations {
  const values = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  return Object.fromEntries(SCENE_KINDS.map(kind => [kind, getSceneSeconds(values, kind)])) as SceneDurations;
}

export function updateSceneDuration(current: SceneDurations, kind: unknown, seconds: unknown): SceneDurations {
  if (!SCENE_KINDS.some(key => key === kind)) throw new Error('Bildirim sahnesi tanınmadı.');
  if (!validSeconds(seconds)) throw new Error('Sahne süresini 1 ile 60 arasında tam saniye olarak gir.');
  return {...current, [kind as SceneKind]: seconds};
}
