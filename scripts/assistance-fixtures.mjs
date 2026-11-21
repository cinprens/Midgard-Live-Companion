// Source-defined synthetic RRF fixtures. These are never real gameplay recordings.
const b = n => Buffer.alloc(n);
const text = value => Buffer.from(`${value}\0`, 'utf8');
const u32 = value => { const out = b(4); out.writeUInt32LE(value); return out; };
const u64 = value => { const out = b(8); out.writeBigUInt64LE(BigInt(value)); return out; };
const generic = (id, data) => { const h = b(6); h.writeInt16LE(id); h.writeInt32LE(data.length, 2); return Buffer.concat([h, data]); };
function encode(input, date) {
  const out = Buffer.from(input);
  const k1 = date.readInt32LE() >> 5, k2 = (12 << 8) >> 3;
  for (let word = 0; word < Math.floor(out.length / 4); word++) out.writeInt32LE(out.readInt32LE(word * 4) ^ Math.imul(k1 + word + 1, k2), word * 4);
  return out;
}
export const status = (parameter, value) => { const out = b(8); out.writeUInt16LE(0x00b0); out.writeUInt16LE(parameter, 2); out.writeInt32LE(value, 4); return out; };
export const ownDeath = (player = 42) => { const out = b(7); out.writeUInt16LE(0x0080); out.writeUInt32LE(player, 2); out[6] = 1; return out; };
export const mapChange = map => { const out = b(22); out.writeUInt16LE(0x0091); text(map).copy(out, 2, 0, 16); return out; };
export const cardReceived = (item = 4317, quantity = 1, slot = 7) => { const out = b(69); out.writeUInt16LE(0x0a37); out.writeUInt16LE(slot, 2); out.writeUInt16LE(quantity, 4); out.writeUInt32LE(item, 6); out[10] = 1; return out; };
export const verifiedItemReceipt = (item = 4317, quantity = 1, slot = 7, before = 60000, after = before + 10) => [status(24, before), cardReceived(item, quantity, slot), status(24, after)];
const emptyBag = () => { const start=b(5),end=b(4);start.writeUInt16LE(0x0b08);start.writeUInt16LE(5,2);end.writeUInt16LE(0x0b0b);return[start,end]; };
export const expReceived = (amount, kind = 'base', player = 42) => { const out = b(18); out.writeUInt16LE(0x0acc); out.writeUInt32LE(player, 2); out.writeBigInt64LE(BigInt(amount), 6); out.writeUInt16LE(kind === 'base' ? 1 : 2, 14); return out; };
export const baselinePackets = () => [status(25, 100000), status(24, 60000), status(11, 40), status(55, 20), status(1, 2000), status(22, 5000), status(2, 100), status(23, 1000), status(5, 10000), mapChange('qa_field'), ...emptyBag(), status(24, 60000)];
export const alertPackets = (player = 42) => [ownDeath(player), status(24, 65000), ...verifiedItemReceipt(4317,1,7,65000,65010), mapChange('prontera'), status(11, 41), expReceived(321, 'base', player), expReceived(123, 'job', player), status(1, 2321), status(2, 223)];
export function assistanceReplay({character = 'QA Çağrı Şövalye', player = 42, packets = baselinePackets(), jobClassId, baseLevel, jobLevel, startingExp, recordingDay = '2026-11-01'} = {}) {
  const header = b(352); Buffer.from('<< Ragnarok Replay File Version 0.05 >>').copy(header); header[100] = 5;
  const [year, month, day] = recordingDay.split('-').map(Number);
  header.writeInt16LE(year, 104); header[106] = month; header[107] = day; header[109] = 12;
  const encrypt = data => encode(data, header.subarray(104,108));
  const stream = Buffer.concat(packets.map((packet, index) => { const h = b(10); h.writeInt32LE(index); h.writeInt32LE(index * 1000, 4); h.writeUInt16LE(packet.length, 8); return Buffer.concat([h, encrypt(packet)]); }));
  const balances = startingExp ? [generic(1015, u64(startingExp.base)), generic(1018, u64(startingExp.requiredBase)),
    generic(1055, u32(startingExp.job)), generic(1054, u32(startingExp.requiredJob))] : [];
  const session = encrypt(Buffer.concat([generic(1010, u32(player)), ...(jobClassId === undefined ? [] : [generic(1014, u32(jobClassId))]), ...(baseLevel === undefined ? [] : [generic(1016, u32(baseLevel))]), ...(jobLevel === undefined ? [] : [generic(1019, u32(jobLevel))]), ...balances]));
  const metadata = encrypt(Buffer.concat([...[0, 1, 2, 3].map(id => generic(id, b(0))), generic(964, text(character)), generic(965, text('qa_field')), generic(970, u32(60000))]));
  let at = header.length;
  for (const [slot, type, data] of [[0, 1, stream], [1, 3, session], [2, 2, metadata]]) { header.writeUInt16LE(type, 112 + slot * 10); header.writeInt32LE(data.length, 114 + slot * 10); header.writeInt32LE(at, 118 + slot * 10); at += data.length; }
  return Buffer.concat([header, stream, session, metadata]);
}
export function syntheticWav() {
  const rate = 8000, samples = 800, out = b(44 + samples * 2);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) out.writeInt16LE(Math.round(Math.sin(i / rate * Math.PI * 2 * 660) * 500), 44 + i * 2);
  return out;
}
