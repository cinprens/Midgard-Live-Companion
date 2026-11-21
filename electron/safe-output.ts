import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Replace the destination directory entry, never write through an existing hard link or symlink. */
export async function atomicOutput(destination: string, create: (temporaryPath: string) => Promise<void>): Promise<void> {
  const temporary = path.join(path.dirname(destination),`.midgard-${randomUUID()}.tmp`);
  const previous = path.join(path.dirname(destination),`.midgard-previous-${randomUUID()}.tmp`);
  try {
    await create(temporary);
    try { await rename(temporary,destination); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM','EEXIST','EACCES'].includes(code ?? '')) throw error;
      // Some Windows file systems reject replacement. Move the old directory entry aside first.
      await rename(destination,previous);
      try { await rename(temporary,destination); }
      catch (replacementError) {
        try { await rename(previous,destination); }
        catch { throw new Error(`Dosya kaydedilemedi. Önceki dosya güvenle korundu: ${previous}`); }
        throw replacementError;
      }
      await unlink(previous);
    }
  }
  finally { await unlink(temporary).catch(() => undefined); }
}
export async function writeOutput(destination: string,data: string): Promise<void> {
  await atomicOutput(destination,temporary => writeFile(temporary,data,{encoding:'utf8',flag:'wx'}));
}
