import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// An additive synthesis score for the bundled loot notification. No audio input files are used.
const sampleRate = 44100;
const duration = 0.68;
const strikes = [
  {onset: 0.00, pitch: 1046.5, level: 0.28},
  {onset: 0.06, pitch: 1396.9, level: 0.23},
  {onset: 0.15, pitch: 1661.2, level: 0.29},
];
const partials = [
  {ratio: 1.00, level: 1.00, decay: 9},
  {ratio: 2.73, level: 0.27, decay: 20},
  {ratio: 4.14, level: 0.13, decay: 32},
];
const samples = Math.round(duration * sampleRate);
const wave = Buffer.alloc(44 + samples * 2);
wave.write('RIFF');
wave.writeUInt32LE(wave.length - 8, 4);
wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20); // PCM, one channel.
wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(sampleRate, 24);
wave.writeUInt32LE(sampleRate * 2, 28);
wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34);
wave.write('data', 36);
wave.writeUInt32LE(samples * 2, 40);

for (let frame = 0; frame < samples; frame++) {
  const time = frame / sampleRate;
  let signal = 0;
  for (const {onset, pitch, level} of strikes) {
    const age = time - onset;
    if (age < 0) continue;
    const attack = 1 - Math.exp(-age * 950);
    for (const part of partials) {
      const phase = 2 * Math.PI * pitch * part.ratio * age;
      signal += level * part.level * attack * Math.exp(-part.decay * age) * Math.sin(phase);
    }
  }
  const fadeOut = Math.min(1, (samples - 1 - frame) / (0.025 * sampleRate));
  wave.writeInt16LE(Math.round(Math.max(-1, Math.min(1, signal * fadeOut)) * 32767), 44 + frame * 2);
}

const output = fileURLToPath(new URL('../build/audio/loot-chime.wav', import.meta.url));
await mkdir(path.dirname(output), {recursive:true});
await writeFile(output, wave);
