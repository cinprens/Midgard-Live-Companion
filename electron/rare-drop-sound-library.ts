import {randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {rareSoundKey, validateRareSoundTarget, type RareSoundTarget, type RareSoundSetting} from '../src/shared/rare-drop-sounds';
import {readMemorySound} from './live-only-session';

interface SavedSound extends RareSoundTarget { file: string }
export class RareDropSoundLibrary {
  private sounds = new Map<string, SavedSound>();
  private candidate?: {token: string; file: string; key: string};

  constructor(saved: unknown, private readonly save: (values: SavedSound[]) => void) {
    if (!Array.isArray(saved)) return;
    for (const row of saved) {
      if (!row || typeof row.file !== 'string' || !path.isAbsolute(row.file) || !/\.(wav|mp3|ogg)$/i.test(row.file)) continue;
      try {
        const target = validateRareSoundTarget({category: row.category, itemId: row.itemId});
        this.sounds.set(rareSoundKey(target), {...target, file: row.file});
      } catch { /* Other saved choices remain available. */ }
    }
  }

  settings(): RareSoundSetting[] {
    return Array.from(this.sounds.values(), ({file, ...target}) => ({...target, fileName: path.basename(file)}));
  }

  async prepare(target: RareSoundTarget, selectedFile: string) {
    const file = await realpath(selectedFile);
    const sound = await readMemorySound(file);
    const token = randomUUID();
    this.candidate = {file, token, key: rareSoundKey(target)};
    return {sound, token};
  }

  apply(target: RareSoundTarget, token: unknown): void {
    const key = rareSoundKey(target);
    const next = new Map(this.sounds);
    if (token === null) {
      next.delete(key);
    } else {
      if (!this.candidate || token !== this.candidate.token || this.candidate.key !== key) throw new Error('Ses seçimi değişti. Dosyayı yeniden seç.');
      next.set(key, {...target, file: this.candidate.file});
    }
    this.save([...next.values()]);
    this.sounds = next;
    if (token !== null) this.candidate = undefined;
  }

  async read(target: RareSoundTarget) {
    const entry = this.sounds.get(rareSoundKey(target));
    return entry ? readMemorySound(entry.file) : null;
  }
}
