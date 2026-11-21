import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { inflate } from 'node:zlib';
import { setImmediate } from 'node:timers/promises';
import { decodeGrfPermutation } from './grf-permutation';

// Format references (independent bounded reader, not GRFEditor code):
// https://github.com/Tokeiburu/GRFEditor/blob/main/GRF/Core/{GrfHeader,FileTable,FileEntry}.cs
const HEADER_BYTES = 46;
const MAX_COMPRESSED_TABLE = 32 * 1024 * 1024;
const MAX_TABLE = 128 * 1024 * 1024;
const MAX_SOUND = 8 * 1024 * 1024;
const MAX_ENTRIES = 500000;
const LEVEL_ENTRIES = ['data\\wav\\levelup.wav', 'data\\wav\\effect\\st_job_level_up.wav'] as const;
const LEVEL_SOUND_NAMES: Readonly<Record<string, string>> = {
  [LEVEL_ENTRIES[0]]: 'Ragnarok seviye atlama sesi',
  [LEVEL_ENTRIES[1]]: 'Ragnarok Job seviye sesi',
};
const MOBSTER_DEATH_ENTRY = 'data\\wav\\mobster_die.wav';
const MOBSTER_SOUND_NAMES: Readonly<Record<string, string>> = {
  [MOBSTER_DEATH_ENTRY]: 'Ragnarok Mobster ölüm sesi',
};
export interface RagnarokLevelSound { name: string; dataUrl: string; entry: string }

function checkedInteger(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('GRF dosya konumu güvenli aralığın dışında.');
  return Number(value);
}
async function readExactly(file: FileHandle, offset: number, length: number, fileSize: number): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > fileSize) throw new Error('GRF veri sınırları geçersiz veya dosya eksik.');
  const buffer = Buffer.alloc(length);
  let at = 0;
  while (at < length) {
    const { bytesRead } = await file.read(buffer, at, length - at, offset + at);
    if (bytesRead === 0) throw new Error('GRF okunurken dosya eksik kaldı.');
    at += bytesRead;
  }
  return buffer;
}
async function inflateBounded(data: Buffer, expected: number, limit: number): Promise<Buffer> {
  if (expected <= 0 || expected > limit) throw new Error('GRF açılmış veri boyutu bellek sınırını aşıyor.');
  const output = await new Promise<Buffer>((resolve, reject) => inflate(data, { maxOutputLength: expected }, (error, result) => error ? reject(new Error('GRF sıkıştırılmış verisi doğrulanamadı.')) : resolve(result)));
  if (output.length !== expected) throw new Error('GRF açılmış veri boyutu dosya tablosuyla uyuşmuyor.');
  return output;
}
function validateWave(wave: Buffer): void {
  if (wave.length < 44 || wave.toString('ascii', 0, 4) !== 'RIFF' || wave.toString('ascii', 8, 12) !== 'WAVE' || wave.readUInt32LE(4) + 8 !== wave.length) throw new Error('GRF içindeki ses geçerli bir WAV dosyası değil.');
  let fmt = false, audio = false;
  for (let at = 12; at + 8 <= wave.length;) {
    const size = wave.readUInt32LE(at + 4), end = at + 8 + size;
    if (end > wave.length) throw new Error('WAV ses parçası eksik.');
    const kind = wave.toString('ascii', at, at + 4);
    if (kind === 'fmt ') {
      if (size < 16 || ![1,3].includes(wave.readUInt16LE(at + 8)) || ![1,2].includes(wave.readUInt16LE(at + 10))) throw new Error('WAV ses biçimi desteklenmiyor.');
      fmt = true;
    }
    if (kind === 'data' && size > 0) audio = true;
    at = end + (size & 1);
  }
  if (!fmt || !audio) throw new Error('WAV dosyasında ses verisi bulunamadı.');
}

/** Read only one allowlisted installed game sound into RAM; never extracts/writes. */
async function readAllowedGameSound(grfPath: string, entryName: string, soundNames: Readonly<Record<string, string>>, purpose: string): Promise<RagnarokLevelSound> {
  const wanted = entryName.replaceAll('/', '\\').toLowerCase();
  if (!Object.hasOwn(soundNames, wanted)) throw new Error(`Yalnızca ${purpose} seçilebilir.`);
  if (path.extname(grfPath).toLowerCase() !== '.grf') throw new Error('Ragnarok kurulumundaki .grf dosyasını seçin.');
  const file = await open(grfPath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < HEADER_BYTES) throw new Error('GRF dosyası geçersiz.');
    const header = await readExactly(file, 0, HEADER_BYTES, stat.size), version = header.readUInt32LE(42);
    const magic = header.toString('latin1', 0, 16);
    if (!(magic === 'Master of Magic\0' || magic.startsWith('Event Horizon\0')) || ![0x200,0x300].includes(version)) throw new Error('Bu GRF sürümü veya başlığı desteklenmiyor.');
    const relative = version === 0x300 && header[35] === 0 && header[36] === 0 && header[37] === 0 ? checkedInteger(header.readBigInt64LE(30)) : header.readUInt32LE(30);
    const tableOffset = HEADER_BYTES + relative, prefixSize = version === 0x300 ? 12 : 8;
    const prefix = await readExactly(file, tableOffset, prefixSize, stat.size);
    if (version === 0x300 && prefix.readUInt32LE(0) !== 0) throw new Error('Korumalı GRF anahtar blokları desteklenmiyor; kendi WAV dosyanızı seçebilirsiniz.');
    const shift = version === 0x300 ? 4 : 0, compressedSize = prefix.readUInt32LE(shift), rawSize = prefix.readUInt32LE(shift + 4);
    if (compressedSize <= 0 || compressedSize > MAX_COMPRESSED_TABLE) throw new Error('GRF dosya tablosu bellek sınırını aşıyor.');
    const compressed = await readExactly(file, tableOffset + prefixSize, compressedSize, stat.size);
    const table = await inflateBounded(compressed, rawSize, MAX_TABLE);
    let at = 0, entries = 0;
    const entryBytes = version === 0x300 ? 21 : 17;
    let selected: { compressed: number; aligned: number; raw: number; flags: number; offset: number } | null = null;
    while (at < table.length) {
      if (++entries > MAX_ENTRIES) throw new Error('GRF girdisi sayısı güvenli sınırı aşıyor.');
      const end = table.indexOf(0, at);
      if (end < at || end - at > 1024 || end + 1 + entryBytes > table.length) throw new Error('GRF dosya tablosu eksik veya bozuk.');
      const name = table.toString('latin1', at, end).replaceAll('/', '\\').toLowerCase(), data = end + 1;
      if (name === wanted) {
        if (selected) throw new Error('GRF içinde aynı ses için birden fazla girdi var.');
        selected = { compressed: table.readUInt32LE(data), aligned: table.readUInt32LE(data + 4), raw: table.readUInt32LE(data + 8), flags: table[data + 12]!, offset: HEADER_BYTES + (version === 0x300 ? checkedInteger(table.readBigInt64LE(data + 13)) : table.readUInt32LE(data + 13)) };
      }
      at = data + entryBytes;
      if (entries % 4096 === 0) await setImmediate();
    }
    if (!selected) throw new Error(`Seçilen GRF içinde ${purpose} bulunamadı. Kendi WAV dosyanızı seçebilirsiniz.`);
    if (![1,3,5].includes(selected.flags)) throw new Error('Bu sesin GRF koruma türü desteklenmiyor; kendi WAV dosyanızı seçebilirsiniz.');
    if (!selected.raw || selected.raw > MAX_SOUND || !selected.compressed || selected.compressed > MAX_SOUND || selected.aligned < selected.compressed || selected.aligned > MAX_SOUND) throw new Error('GRF sesi 8 MiB güvenli bellek sınırını aşıyor veya boyutu geçersiz.');
    if (selected.offset + selected.aligned > tableOffset) throw new Error('GRF ses girdisi veri bölümü dışında.');
    const body = await readExactly(file, selected.offset, selected.aligned, stat.size);
    decodeGrfPermutation(body, selected.flags, selected.compressed);
    const wave = await inflateBounded(body.subarray(0, selected.compressed), selected.raw, MAX_SOUND);
    validateWave(wave);
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('GRF okunurken değişti; oyun güncellemesi bittikten sonra tekrar deneyin.');
    return { name: soundNames[wanted]!, entry: wanted, dataUrl: `data:audio/wav;base64,${wave.toString('base64')}` };
  } finally { await file.close(); }
}

export async function readRagnarokLevelSound(grfPath: string, entryName: string = LEVEL_ENTRIES[0]): Promise<RagnarokLevelSound> {
  return readAllowedGameSound(grfPath, entryName, LEVEL_SOUND_NAMES, 'Ragnarok seviye atlama sesi');
}

export async function readRagnarokMobsterSound(grfPath: string, entryName: string = MOBSTER_DEATH_ENTRY): Promise<RagnarokLevelSound> {
  return readAllowedGameSound(grfPath, entryName, MOBSTER_SOUND_NAMES, 'Ragnarok Mobster ölüm sesi');
}
