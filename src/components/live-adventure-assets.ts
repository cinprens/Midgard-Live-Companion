import type {LiveAppearanceId} from '../shared/live-appearance';
import feminine1 from '../assets/live/pixel-party/feminine-1.webp';
import feminine2 from '../assets/live/pixel-party/feminine-2.webp';
import feminine3 from '../assets/live/pixel-party/feminine-3.webp';
import feminine4 from '../assets/live/pixel-party/feminine-4.webp';
import masculine1 from '../assets/live/pixel-party/masculine-1.webp';
import masculine2 from '../assets/live/pixel-party/masculine-2.webp';
import masculine3 from '../assets/live/pixel-party/masculine-3.webp';
import scene from '../assets/live/pixel-party/camp.webp';
import card from '../assets/live/adventure/loot-card.png';
import costume from '../assets/live/adventure/loot-costume.png';
import generic from '../assets/live/adventure/loot-generic.png';

export const LIVE_CHARACTER_ART:Record<LiveAppearanceId,string>={
  'feminine-1':feminine1,'feminine-2':feminine2,'feminine-3':feminine3,'feminine-4':feminine4,
  'masculine-1':masculine1,'masculine-2':masculine2,'masculine-3':masculine3,
};
export const LIVE_SCENE_ART=scene;
export const LIVE_LOOT_ART={card,costume,generic} as const;
