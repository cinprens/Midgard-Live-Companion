import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {RareDropSoundLibrary} from '../electron/rare-drop-sound-library';
import {validateRareSoundTarget} from '../src/shared/rare-drop-sounds';

const card = {category:'card'} as const;
const override = {category:'card',itemId:4317} as const;
const costume = {category:'costume'} as const;
let temp: string, wav: string;
beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(),'midgard-drop-sound-'));
  wav = path.join(temp,'loot.wav');
  await writeFile(wav,Buffer.from('RIFF0000WAVEdata'));
});
afterEach(async () => {await rm(temp,{recursive:true,force:true});});

describe('yerel ganimet ses tercihleri', () => {
  it('eski profili boş açar, seçili sesi tek kullanımlık izinle saklar ve yeniden açar', async () => {
    const save = vi.fn();
    const library = new RareDropSoundLibrary(undefined,save);
    expect(library.settings()).toEqual([]);
    expect(await library.read(card)).toBeNull();
    const choice = await library.prepare(override,wav);
    expect(choice.sound.name).toBe('loot.wav');
    expect(() => library.apply(costume,choice.token)).toThrow();
    expect(() => library.apply(override,wav)).toThrow();
    expect(save).not.toHaveBeenCalled();
    library.apply(override,choice.token);
    expect(() => library.apply(override,choice.token)).toThrow();
    const reopened = new RareDropSoundLibrary(save.mock.calls[0][0],save);
    expect(reopened.settings()).toEqual([{...override,fileName:'loot.wav'}]);
    expect(await reopened.read(override)).toEqual(choice.sound);
    expect(await reopened.read(card)).toBeNull();
    reopened.apply(override,null);
    expect(reopened.settings()).toEqual([]);
    expect(save).toHaveBeenLastCalledWith([]);
  });

  it('yarım kalan seçim veya başarısız kayıt eski ayarı korur; diğer kategori ayrı kalır',async () => {
    const save = vi.fn();
    const library = new RareDropSoundLibrary([{...card,file:wav}], save);
    await library.prepare(override,wav);
    expect(library.settings()).toEqual([{...card,fileName:'loot.wav'}]);
    const next = await library.prepare(costume,wav);
    save.mockImplementationOnce(()=>{throw new Error('disk dolu');});
    expect(()=>library.apply(costume,next.token)).toThrow('disk dolu');
    expect(library.settings()).toEqual([{...card,fileName:'loot.wav'}]);
    library.apply(costume,next.token);
    expect(library.settings()).toHaveLength(2);
    library.apply(card,null);
    expect(library.settings()).toEqual([{...costume,fileName:'loot.wav'}]);
  });

  it('eksik veya geçersiz sesin içeriğini döndürmez ve ilgisiz kullanıcı ayarlarını korur',async () => {
    const missing = path.join(temp,'missing.ogg');
    const library = new RareDropSoundLibrary([{...card,file:missing},{...costume,file:wav},{category:'other',file:wav},{...override,file:'wrong.mp3'}],vi.fn());
    expect(library.settings()).toHaveLength(2);
    await expect(library.read(card)).rejects.toThrow();
    await writeFile(wav,'Bu bir ses kaydı değil.');
    await expect(library.prepare(override,wav)).rejects.toThrow();
    expect(library.settings()).toHaveLength(2);
  });

  it('yalnız doğrulanmış kategori ve tam sayı kimliği kabul eder',() => {
    expect(validateRareSoundTarget(card)).toEqual(card);
    expect(validateRareSoundTarget(override)).toEqual(override);
    for(const value of [null,{category:'hat'},{...card,itemId:0},{...card,itemId:'4317'},{...card,itemId:2**32},{...card,file:wav}]) {
      expect(()=>validateRareSoundTarget(value)).toThrow();
    }
  });
});
