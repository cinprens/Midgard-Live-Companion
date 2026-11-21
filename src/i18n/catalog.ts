import live from './live.en';
import progression from './progression.en';
import notifications from './notifications.en';
import shell from './shell.en';
import {currentLanguage, type Language} from './locale';

export const english: Readonly<Record<string,string>> = Object.freeze({...progression, ...live, ...notifications, ...shell});
const slot = /\{(\d+)\}/g;
const originalMessages = new Map(Object.entries(english).filter(([tr,en])=>tr!==en).map(([tr,en])=>[en,tr]));

function fill(format: string, values: readonly unknown[]) {
  return format.replace(slot, (_, i: string) => String(values[Number(i)]));
}

export function translate(key: string, ...values: unknown[]) {
  return fill(currentLanguage() === 'en' ? english[key] ?? key : key, values);
}

// Replay notifications and stored diagnostics arrive as complete Turkish messages.
// Match only known message formats. Captured names, paths and values stay verbatim.
const formats = Object.entries(english).filter(([key]) => key.includes('{') && /[a-zA-ZçÇşŞıİöÖüÜğĞ]{3}/.test(key))
  .sort(([a],[b]) => b.length-a.length).map(([source, target]) => ({
    parts: source.split(/\{\d+\}/), indices: [...source.matchAll(/\{(\d+)\}/g)].map(m=>Number(m[1])), target,
  }));

export function serviceMessage<T>(value: T, language: Language = currentLanguage()): T {
  if (typeof value !== 'string' || !value) return value;
  if (language === 'tr') return (originalMessages.get(value) ?? value) as T;
  if (Object.hasOwn(english, value)) return english[value] as T;
  if (value.length > 4096) return value;
  const diagnostic = /^(\[[A-Z][A-Z0-9_:-]*\]\s+|(?:Error invoking remote method '[^'\n]+': )?Error: )([^\n][\s\S]*)$/.exec(value);
  if (diagnostic) return (diagnostic[1]+serviceMessage(diagnostic[2], language)) as T;
  for (const {parts, indices, target} of formats) {
    if (!value.startsWith(parts[0]) || !value.endsWith(parts[parts.length-1])) continue;
    let start = parts[0].length;
    const values: string[] = [];
    const matched = indices.every((index, i) => {
      const next = parts[i+1];
      if (!next && i < indices.length-1) return false;
      const end = i === indices.length-1 ? value.length-next.length : value.indexOf(next, start);
      if (end < start) return false;
      values[index] = value.slice(start,end);
      start = end + next.length;
      return true;
    });
    if (matched) return fill(target, values) as T;
  }
  return value;
}
