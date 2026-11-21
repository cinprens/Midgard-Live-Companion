import {lstat, open, readdir, realpath} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {decryptChunk, deriveKeys, readHeader, readKoreanZ} from 'rrfparser';
import {decodeSessionTelemetry} from '../src/parser/telemetry';
import {summarizeReplayStarts, type ReplayComparisonResult, type ReplayExperiencePoint} from '../src/domain/replay-experience-comparison';

const HEADER = 352;
const MAX_SECTION = 256 * 1024;
const pathKey = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;

async function bytesAt(handle: FileHandle, offset: number, length: number) {
  const bytes = new Uint8Array(length);
  let used = 0;
  while (used < length) {
    const {bytesRead} = await handle.read(bytes, used, length - used, offset + used);
    if (!bytesRead) throw new Error('Replay başlığı henüz tamamlanmadı.');
    used += bytesRead;
  }
  return bytes;
}

function fields(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: {id:number; data:Uint8Array}[] = [];
  for (let at = 0; at < bytes.length;) {
    if (result.length >= 4096 || at + 6 > bytes.length) throw new Error('Replay başlangıç alanları geçersiz.');
    const id = view.getUint16(at, true), length = view.getInt32(at + 2, true);
    at += 6;
    if (length < 0 || length > bytes.length - at) throw new Error('Replay başlangıç alanı eksik.');
    result.push({id, data: bytes.subarray(at, at + length)});
    at += length;
  }
  return result;
}

/** Read only the descriptor table and the two recording-start sections, even on long active Replays. */
export async function readReplayExperiencePoint(file: string): Promise<ReplayExperiencePoint> {
  if (path.extname(file).toLowerCase() !== '.rrf' || !(await lstat(file)).isFile()) throw new Error('Geçerli bir Replay dosyası seçin.');
  const canonical = await realpath(file);
  const handle = await open(canonical, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Replay dosyası açılamadı.');
    const header = await bytesAt(handle, 0, HEADER);
    const {recordedAt: d} = readHeader(header.buffer);
    const time = new Date(Date.UTC(d.year,d.month-1,d.day,d.hour,d.minute,d.second));
    if (d.year < 2000 || d.year > 2200 || time.getUTCMonth()+1 !== d.month || time.getUTCDate() !== d.day ||
        d.hour > 23 || d.minute > 59 || d.second > 59) throw new Error('Replay kayıt tarihi geçersiz.');
    const keys = deriveKeys(d), view = new DataView(header.buffer);
    const regions: {type:number; start:number; end:number}[] = [];
    for (let slot=0; slot<24; slot++) {
      const at = 112 + 10 * slot, type = view.getUint16(at,true);
      const declared = view.getInt32(at+2,true), start = view.getInt32(at+6,true);
      if (!declared && !start) continue;
      const end = declared === 0 ? stat.size : start + declared;
      if (start < HEADER || declared < 0 || end < start || end > stat.size ||
          regions.some(prior => start < prior.end && end > prior.start)) throw new Error('Replay bölüm tablosu geçersiz.');
      regions.push({type,start,end});
    }
    async function loadBytes(type:number) {
      const matches = regions.filter(r=>r.type===type);
      if (matches.length !== 1) throw new Error('Replay başlangıç bölümü eksik veya belirsiz.');
      const region = matches[0], length = region.end - region.start;
      if (length <= 0 || length > MAX_SECTION) throw new Error('Replay başlangıç bölümü geçersiz.');
      return bytesAt(handle,region.start,length);
    }
    const [metaBytes,sessionBytes] = await Promise.all([loadBytes(2),loadBytes(3)]);
    const meta = fields(decryptChunk(metaBytes,metaBytes.length,keys));
    const session = fields(decryptChunk(sessionBytes,sessionBytes.length,keys));
    const names = meta.filter(f=>f.id===964);
    const players = session.filter(f=>f.id===1010);
    if (names.length !== 1 || !names[0].data.length || names[0].data.length > 1024 ||
        players.length !== 1 || players[0].data.length !== 4) throw new Error('Karakter kimliği doğrulanamadı.');
    const nameBytes = names[0].data;
    const end = nameBytes.indexOf(0);
    const name = nameBytes.subarray(0, end === -1 ? nameBytes.length : end);
    let character: string;
    try {character = new TextDecoder('utf-8',{fatal:true}).decode(name);}
    catch {character = readKoreanZ(name);}
    const player = new DataView(players[0].data.buffer,players[0].data.byteOffset,4).getUint32(0,true);
    if (!character.trim() || !player || /[\u0000-\u001f\u007f\ufffd]/u.test(character)) throw new Error('Karakter kimliği okunamadı.');
    const telemetry = decodeSessionTelemetry(session);
    const after = await handle.stat();
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) {
      const [updatedHeader,updatedMeta,updatedSession] = await Promise.all([bytesAt(handle,0,HEADER),loadBytes(2),loadBytes(3)]);
      const same = (a:Uint8Array,b:Uint8Array) => a.length === b.length && a.every((value,i)=>value===b[i]);
      const descriptors = (bytes:Uint8Array) => {
        const dv = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
        return Array.from({length:24},(_,i)=>112+i*10).filter(at=>[2,3].includes(dv.getUint16(at,true)))
          .map(at=>Buffer.from(bytes.subarray(at,at+10)).toString('hex')).join(',');
      };
      if (!same(header.subarray(0,112),updatedHeader.subarray(0,112)) || descriptors(header)!==descriptors(updatedHeader) ||
          !same(metaBytes,updatedMeta) || !same(sessionBytes,updatedSession)) throw new Error('Replay başlangıcı okuma sırasında değişti.');
    }
    // Use the verified name bytes and account ID together. Separate folders can belong to different game worlds.
    const identity = JSON.stringify([pathKey(path.dirname(canonical)), player, Buffer.from(name).toString('hex')]);
    return {character,characterKey:`recorded:${player}:${encodeURIComponent(character)}`,identity,filename:path.basename(file),sourcePath:canonical,startedAt:time.toISOString().slice(0,19),
      baseLevel:telemetry.baseLevel??null,jobLevel:telemetry.jobLevel??null,
      jobClassId:telemetry.jobClassId ?? null, exp:telemetry.recordingStartExp ?? {}};
  } finally {await handle.close();}
}

export async function compareReplayFiles(files: readonly string[], chosen = false): Promise<ReplayComparisonResult> {
  const points: ReplayExperiencePoint[] = [];
  let unreadable = 0;
  for (const file of files) {
    try {points.push(await readReplayExperiencePoint(file));}
    catch (error) {if (chosen) throw error; unreadable++;}
  }
  const {intervals, latestStarts} = summarizeReplayStarts(points);
  if (chosen && !intervals.length) throw new Error('Aynı klasörde, aynı karaktere ait ve farklı zamanlarda başlamış iki Replay seçin.');
  return {intervals, latestStarts, inspected: files.length, unreadable};
}

export async function compareTrackedReplays(folder: string | null, tracked: readonly string[]): Promise<ReplayComparisonResult> {
  const paths = new Map(tracked.map(file => [pathKey(path.resolve(file)), file]));
  if (folder) {
    for (const entry of await readdir(folder,{withFileTypes:true})) {
      if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.rrf') {
        const file = path.join(folder,entry.name);
        paths.set(pathKey(path.resolve(file)),file);
      }
    }
  }
  return compareReplayFiles([...paths.values()]);
}
