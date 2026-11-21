import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {UiLanguage} from '../electron/ui-language';
import {applyLanguage, currentLocale} from '../src/i18n/locale';
import {english, serviceMessage, translate} from '../src/i18n/catalog';
import {startupScreenUrl} from '../electron/startup-screen';
import {localizeSource} from '../scripts/localize-ui';

afterEach(()=>applyLanguage('tr'));

describe('offline interface language',()=>{
  it('keeps the original arguments when translating a Replay notification',()=>{
    const original='Canlı: Karakter öldü.';
    expect(serviceMessage(original,'en')).toBe(english['{0}: Karakter öldü.'].replace('{0}','Canlı'));
    expect(serviceMessage('[REPLAY] '+original,'en')).toBe('[REPLAY] '+serviceMessage(original,'en'));
    expect(serviceMessage(original,'tr')).toBe(original);
    expect(serviceMessage('C:\\Replay\\Çanta\\Açık.rrf','en')).toBe('C:\\Replay\\Çanta\\Açık.rrf');
  });
  it('updates formatted text both ways without changing the data',()=>{
    applyLanguage('en');
    expect(currentLocale()).toBe('en-US');
    expect(translate('%{0}',98.7)).toBe('98.7%');
    applyLanguage('tr');
    expect(translate('%{0}','98,7')).toBe('%98,7');
  });
  it('localizes authored labels without translating the player binding or the identifier of the control',()=>{
    const compiled=localizeSource('/project/src/components/Example.tsx','export const Title=({name})=><b data-id="Canlı" title="Canlı">{name}</b>;');
    expect(compiled).toContain('data-id="Canlı"');
    expect(compiled).toContain('title={__mlText("Canlı")}');
    expect(compiled).toContain('{name}</b>');
  });
  it('restores the language before startup and preserves native file filters',()=>{
    const folder=mkdtempSync(path.join(tmpdir(),'midgard-language-'));
    try {
      writeFileSync(path.join(folder,'ui-language'),'invalid');
      const prefs=new UiLanguage(folder);
      expect(prefs.value).toBe('tr');
      prefs.set('en');
      const restored=new UiLanguage(folder);
      expect(restored.value).toBe('en');
      expect(decodeURIComponent(startupScreenUrl(restored.value))).toContain('<html lang="en"');
      expect(restored.dialog({title:'Replay kaynak klasörünü seç',filters:[{name:'Ragnarok Replay',extensions:['rrf']}]}))
        .toEqual({title:'Choose your Replay folder',filters:[{name:'Ragnarok Replay',extensions:['rrf']}]});
      expect(()=>restored.set('xx')).toThrow();
      expect(readFileSync(path.join(folder,'ui-language'),'utf8')).toBe('en');
    } finally {rmSync(folder,{recursive:true,force:true});}
  });
});
