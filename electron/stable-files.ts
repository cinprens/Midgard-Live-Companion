import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const MAX_REPLAY_BYTES = 128 * 1024 * 1024;
export interface FileSample { size: number; mtimeMs: number; }

export class FileStabilityTracker {
  private samples = new Map<string, { signature: string; count: number }>();
  constructor(private requiredSamples = 3, private minimumAgeMs = 2000) {}
  observe(file: string, sample: FileSample, now = Date.now()): boolean {
    const signature = `${sample.size}:${sample.mtimeMs}`;
    const previous = this.samples.get(file);
    const count = previous?.signature === signature ? previous.count + 1 : 1;
    this.samples.set(file, { signature, count });
    return sample.size > 0 && sample.size <= MAX_REPLAY_BYTES && count >= this.requiredSamples && now - sample.mtimeMs >= this.minimumAgeMs;
  }
  prune(existing: Set<string>): void {
    for (const file of this.samples.keys()) if (!existing.has(file)) this.samples.delete(file);
  }
}

export async function withinFolder(file: string, directory: string): Promise<boolean> {
  const [actualFile, actualDirectory] = await Promise.all([realpath(file), realpath(directory)]);
  const relative = path.relative(actualDirectory, actualFile);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export async function readStableReplay(file: string, delayMs = 750): Promise<Uint8Array> {
  if (path.extname(file).toLowerCase() !== '.rrf') throw new Error('Yalnızca .rrf Replay dosyaları seçilebilir.');
  const tracker = new FileStabilityTracker();
  for (let attempt = 0; attempt < 8; attempt++) {
    const sample = await stat(file);
    if (!sample.isFile()) throw new Error('Seçilen yol bir dosya değil.');
    if (sample.size > MAX_REPLAY_BYTES) throw new Error('Dosya 128 MiB güvenli analiz sınırını aşıyor.');
    if (sample.size === 0) throw new Error('Replay dosyası boş; kaydın tamamlanmasını bekleyin.');
    if (!tracker.observe(file, sample)) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      continue;
    }
    const handle = await open(file, 'r');
    try {
      const before = await handle.stat();
      if (before.size === 0 || before.size > MAX_REPLAY_BYTES) throw new Error('Replay dosyası boş veya 128 MiB güvenli analiz sınırını aşıyor.');
      const bytes = new Uint8Array(before.size);
      let position = 0;
      while (position < bytes.byteLength) {
        const chunk = await handle.read(bytes,position,Math.min(1024 * 1024,bytes.byteLength - position),position);
        if (chunk.bytesRead === 0) break;
        position += chunk.bytesRead;
      }
      const trailing = new Uint8Array(1);
      const extra = await handle.read(trailing,0,1,bytes.byteLength);
      const after = await handle.stat();
      const currentPath = await stat(file);
      if (position !== bytes.byteLength || extra.bytesRead !== 0 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || currentPath.size !== after.size || currentPath.mtimeMs !== after.mtimeMs || bytes.byteLength !== after.size) {
        throw new Error('Replay dosyası okunurken değişti; kayıt tamamlandığında tekrar deneyin.');
      }
      return bytes;
    } finally { await handle.close(); }
  }
  throw new Error('Replay dosyası hâlâ yazılıyor veya kilitli. Kayıt tamamlandıktan sonra tekrar deneyin.');
}
