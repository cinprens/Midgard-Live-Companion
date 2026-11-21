export type Language = 'tr' | 'en';

let active: Language = 'tr';
const listeners = new Set<() => void>();
export const currentLanguage = () => active;
export const currentLocale = () => active === 'en' ? 'en-US' : 'tr-TR';

export function subscribeLanguage(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function applyLanguage(next: Language) {
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  if (next === active) return;
  active = next;
  for (const notify of listeners) notify();
}
