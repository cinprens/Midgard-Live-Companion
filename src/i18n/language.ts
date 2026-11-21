import {useSyncExternalStore} from 'react';
import {applyLanguage, currentLanguage, subscribeLanguage, type Language} from './locale';

const key = 'midgard-ui-language';
export function useLanguage() {
  return useSyncExternalStore(subscribeLanguage, currentLanguage, currentLanguage);
}

export async function restoreLanguage() {
  try {
    const saved = window.midgard?.getLanguage ? await window.midgard.getLanguage() : localStorage.getItem(key);
    applyLanguage(saved === 'en' ? 'en' : 'tr');
  } catch { applyLanguage('tr'); }
}

export async function chooseLanguage(next: Language) {
  applyLanguage(next);
  if (window.midgard?.setLanguage) await window.midgard.setLanguage(next);
  else localStorage.setItem(key, next);
}
