import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { readRagnarokLevelSound, readRagnarokMobsterSound } from '../electron/ragnarok-sound';
import { grfBlockTransform } from '../electron/grf-permutation';

const temporary: { directory: string; filename: string }[] = [];
afterEach(async () => { for (const entry of temporary.splice(0)) { await unlink(entry.filename); await rmdir(entry.directory); } });

function wave(): Buffer {
  const buffer = Buffer.alloc(244);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(22050, 24); buffer.writeUInt32LE(44100, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(200, 40);
  for (let i = 44; i < buffer.length; i++) buffer[i] = (i * i + i * 73) & 255;
  return buffer;
}
function archive(options: { version?: number; flags?: number; name?: string; audio?: Buffer; declaredTableSize?: number; soundOffset?: bigint; keyBlock?: number; soundRawSize?: number; duplicate?: boolean } = {}): Buffer {
  const version = options.version ?? 0x300, flags = options.flags ?? 1;
  const audio = options.audio ?? wave(), sound = deflateSync(audio), body = Buffer.alloc(Math.ceil(sound.length / 8) * 8);
  body.set(sound);
  if (flags === 5) for (let i = 0; i < Math.min(160, body.length); i += 8) grfBlockTransform(body.subarray(i, i + 8));
  if (flags === 3) {
    // Independent fixture encoder reverses the documented MIXCRYPT byte shuffle.
    const digits = String(sound.length).length, interval = digits < 3 ? 3 : digits < 5 ? digits + 1 : digits < 7 ? digits + 9 : digits + 15;
    const substitutions = new Map([[0,43],[43,0],[1,104],[104,1],[72,119],[119,72],[96,255],[255,96],[108,128],[128,108],[185,192],[192,185],[235,254],[254,235]]);
    let skipped = 0;
    for (let i = 0; i < body.length / 8; i++) {
      const block = body.subarray(i * 8, i * 8 + 8);
      if (i < 20 || i % interval === 0) grfBlockTransform(block);
      else {
        if (skipped === 7) {
          const before = Buffer.from(block);
          block.set([before[3]!,before[4]!,before[5]!,before[0]!,before[1]!,before[6]!,before[2]!,substitutions.get(before[7]!) ?? before[7]!]);
          skipped = 0;
        }
        skipped++;
      }
    }
  }
  const name = Buffer.from((options.name ?? 'data\\wav\\levelup.wav') + '\0', 'latin1'), metadata = Buffer.alloc(version === 0x300 ? 21 : 17);
  metadata.writeUInt32LE(sound.length, 0); metadata.writeUInt32LE(body.length, 4); metadata.writeUInt32LE(options.soundRawSize ?? audio.length, 8); metadata[12] = flags;
  if (version === 0x300) metadata.writeBigUInt64LE(options.soundOffset ?? 0n, 13); else metadata.writeUInt32LE(Number(options.soundOffset ?? 0n), 13);
  const table = Buffer.concat(options.duplicate ? [name, metadata, name, metadata] : [name, metadata]), packedTable = deflateSync(table), prefix = Buffer.alloc(version === 0x300 ? 12 : 8);
  const shift = version === 0x300 ? 4 : 0;
  if (shift) prefix.writeUInt32LE(options.keyBlock ?? 0, 0);
  prefix.writeUInt32LE(packedTable.length, shift); prefix.writeUInt32LE(options.declaredTableSize ?? table.length, shift + 4);
  const header = Buffer.alloc(46); header.write(version === 0x300 ? 'Event Horizon\0' : 'Master of Magic\0', 0, 'latin1');
  header.writeUInt32LE(body.length, 30); header.writeUInt32LE(options.duplicate ? 2 : 1, 38); header.writeUInt32LE(version, 42);
  return Buffer.concat([header, body, prefix, packedTable]);
}
async function file(data: Buffer): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'midgard-synthetic-grf-')), filename = path.join(directory, 'synthetic.grf');
  await writeFile(filename, data); temporary.push({ directory, filename }); return filename;
}

describe('bounded installed GRF level sound reader', () => {
  it.each([0x200, 0x300])('reads a synthetic GRF%x original PCM only into a data URL', async version => {
    const result = await readRagnarokLevelSound(await file(archive({ version })));
    expect(result.entry).toBe('data\\wav\\levelup.wav');
    expect(Buffer.from(result.dataUrl.split(',')[1]!, 'base64')).toEqual(wave());
  });
  it('decodes a standard legacy header-permuted entry', async () => {
    const result = await readRagnarokLevelSound(await file(archive({ flags: 5 })));
    expect(Buffer.from(result.dataUrl.split(',')[1]!, 'base64')).toEqual(wave());
  });
  it('decodes MIXCRYPT body blocks and repeated skipped-block shuffles', async () => {
    const audio = Buffer.alloc(2044); wave().copy(audio, 0, 0, 44);
    audio.writeUInt32LE(audio.length - 8, 4); audio.writeUInt32LE(audio.length - 44, 40);
    let seed = 42719;
    for (let i = 44; i < audio.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; audio[i] = seed >>> 24; }
    const result = await readRagnarokLevelSound(await file(archive({ flags: 3, audio })));
    expect(Buffer.from(result.dataUrl.split(',')[1]!, 'base64')).toEqual(audio);
  });
  it('restores the exact allowlisted Job sound and rejects arbitrary archive paths', async () => {
    const source = await file(archive({ name: 'data\\wav\\effect\\st_job_level_up.wav' }));
    expect((await readRagnarokLevelSound(source, 'data/wav/effect/st_job_level_up.wav')).name).toContain('Job');
    await expect(readRagnarokLevelSound(source, '..\\secret.wav')).rejects.toThrow('Yalnızca');
    await expect(readRagnarokLevelSound(source)).rejects.toThrow('bulunamadı');
  });
  it('refuses protected formats and custom key blocks', async () => {
    await expect(readRagnarokLevelSound(await file(archive({ flags: 0x80 })))).rejects.toThrow('koruma');
    await expect(readRagnarokLevelSound(await file(archive({ keyBlock: 1 })))).rejects.toThrow('anahtar');
  });
  it('bounds decompression before allocating declared table or sound output', async () => {
    await expect(readRagnarokLevelSound(await file(archive({ declaredTableSize: 128 * 1024 * 1024 + 1 })))).rejects.toThrow('bellek');
    await expect(readRagnarokLevelSound(await file(archive({ soundRawSize: 8 * 1024 * 1024 + 1 })))).rejects.toThrow('bellek');
    await expect(readRagnarokLevelSound(await file(archive({ declaredTableSize: 1 })))).rejects.toThrow('doğrulanamadı');
  });
  it('rejects unsafe 64-bit entry offsets, truncated files, and malformed WAV data', async () => {
    await expect(readRagnarokLevelSound(await file(archive({ soundOffset: 9007199254740992n })))).rejects.toThrow('güvenli');
    await expect(readRagnarokLevelSound(await file(archive().subarray(0, 45)))).rejects.toThrow('geçersiz');
    await expect(readRagnarokLevelSound(await file(archive({ audio: Buffer.from('not a WAVE file') })))).rejects.toThrow('WAV');
  });
  it('checks zlib checksum rather than returning a damaged sound', async () => {
    const data = archive(); data[50] ^= 0xff;
    await expect(readRagnarokLevelSound(await file(data))).rejects.toThrow('doğrulanamadı');
  });
});

describe('bounded installed GRF Mobster death sound reader', () => {
  const deathEntry = 'data\\wav\\mobster_die.wav';
  it.each([0x200, 0x300])('reads only the verified Mobster death entry from GRF%x', async version => {
    const result = await readRagnarokMobsterSound(await file(archive({ version, name: deathEntry })));
    expect(result.name).toBe('Ragnarok Mobster ölüm sesi');
    expect(result.entry).toBe(deathEntry);
    expect(Buffer.from(result.dataUrl.split(',')[1]!, 'base64')).toEqual(wave());
  });
  it.each([3, 5])('retains the existing bounded legacy permutation decoder for flags %i', async flags => {
    const result = await readRagnarokMobsterSound(await file(archive({ name: deathEntry, flags })));
    expect(Buffer.from(result.dataUrl.split(',')[1]!, 'base64')).toEqual(wave());
  });
  it('normalizes slash and case without accepting other entries or crossing sound purposes', async () => {
    const source = await file(archive({ name: deathEntry }));
    expect((await readRagnarokMobsterSound(source, 'DATA/WAV/MOBSTER_DIE.WAV')).entry).toBe(deathEntry);
    for (const entry of ['data\\wav\\mobster_attack.wav', 'data\\wav\\mobster_damage.wav', 'data\\wav\\levelup.wav', '..\\mobster_die.wav', '__proto__']) {
      await expect(readRagnarokMobsterSound(source, entry)).rejects.toThrow('Yalnızca');
    }
    await expect(readRagnarokLevelSound(source, deathEntry)).rejects.toThrow('Yalnızca');
    await expect(readRagnarokLevelSound(source)).rejects.toThrow('bulunamadı');
    await expect(readRagnarokMobsterSound(await file(archive()))).rejects.toThrow('bulunamadı');
    await expect(readRagnarokMobsterSound('unrelated.wav')).rejects.toThrow('.grf');
  });
  it('rejects missing, duplicated, protected or unsafe Mobster entries', async () => {
    await expect(readRagnarokMobsterSound(await file(archive({ name: 'data\\wav\\mobster_attack.wav' })))).rejects.toThrow('bulunamadı');
    await expect(readRagnarokMobsterSound(await file(archive({ name: deathEntry, duplicate: true })))).rejects.toThrow('birden fazla');
    await expect(readRagnarokMobsterSound(await file(archive({ name: deathEntry, flags: 0x80 })))).rejects.toThrow('koruma');
    await expect(readRagnarokMobsterSound(await file(archive({ name: deathEntry, keyBlock: 1 })))).rejects.toThrow('anahtar');
    await expect(readRagnarokMobsterSound(await file(archive({ name: deathEntry, soundOffset: 9007199254740992n })))).rejects.toThrow('güvenli');
  });
  it('bounds both decompression layers and rejects truncated or malformed Mobster data', async () => {
    await expect(readRagnarokMobsterSound(await file(archive({ name: deathEntry, declaredTableSize: 128 * 1024 * 1024 + 1 })))).rejects.toThrow('bellek');
    await expect(readRagnarokMobsterSound(await file(archive({ name: deathEntry, soundRawSize: 8 * 1024 * 1024 + 1 })))).rejects.toThrow('bellek');
    await expect(readRagnarokMobsterSound(await file(archive({ name: deathEntry }).subarray(0, 45)))).rejects.toThrow('geçersiz');
    await expect(readRagnarokMobsterSound(await file(archive({ name: deathEntry, audio: Buffer.from('not a WAVE file') })))).rejects.toThrow('WAV');
    const damaged = archive({ name: deathEntry }); damaged[50] ^= 0xff;
    await expect(readRagnarokMobsterSound(await file(damaged))).rejects.toThrow('doğrulanamadı');
  });
  it('keeps the archive unchanged and creates no extracted sound file', async () => {
    const contents = archive({ name: deathEntry }), source = await file(contents);
    await readRagnarokMobsterSound(source);
    expect(await readFile(source)).toEqual(contents);
    expect(await readdir(path.dirname(source))).toEqual(['synthetic.grf']);
  });
});
