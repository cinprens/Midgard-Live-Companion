export const LIVE_APPEARANCES = [
  {id:'feminine-1',label:'Zümrüt Gezgin',presentation:'feminine'},
  {id:'feminine-2',label:'Ayışığı Büyücüsü',presentation:'feminine'},
  {id:'feminine-3',label:'Kızıl Muhafız',presentation:'feminine'},
  {id:'feminine-4',label:'İnci Şifacı',presentation:'feminine'},
  {id:'masculine-1',label:'Kehribar Gezgin',presentation:'masculine'},
  {id:'masculine-2',label:'Gece Muhafızı',presentation:'masculine'},
  {id:'masculine-3',label:'Bilge Yolcu',presentation:'masculine'},
] as const;

export type LiveAppearanceId = typeof LIVE_APPEARANCES[number]['id'];
const appearanceIds:ReadonlySet<string>=new Set(LIVE_APPEARANCES.map(appearance=>appearance.id));

export function isLiveAppearanceId(value:unknown):value is LiveAppearanceId {
  return typeof value==='string'&&appearanceIds.has(value);
}

/** An unchosen character uses a neutral crest; names never determine appearance. */
export function liveAppearanceForCharacter(choices:Readonly<Record<string,LiveAppearanceId>>|undefined,characterKey:string|null|undefined):LiveAppearanceId|null {
  if(!choices||!characterKey||!Object.hasOwn(choices,characterKey))return null;
  const value=choices[characterKey];
  return isLiveAppearanceId(value)?value:null;
}
