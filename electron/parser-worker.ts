import { parentPort } from 'node:worker_threads';
import { parseReplay } from '../src/parser';

parentPort?.on('message', (request: {bytes: ArrayBuffer; filename: string}) => {
  try { parentPort?.postMessage({ ok: true, parsed: parseReplay(request.bytes,request.filename) }); }
  catch (error) { parentPort?.postMessage({ok:false,error:error instanceof Error ? error.message : 'Replay ayrıştırılamadı.'}); }
});
