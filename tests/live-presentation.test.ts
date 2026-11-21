import { describe, expect, it } from 'vitest';
import { formatLiveBytes, getCharacterInitials, liveStatusPresentation, matchesLiveSearch } from '../src/domain/live-presentation';
import type { LiveStreamState,LiveStreamStatus } from '../src/shared/types';

describe('Turkish live presentation', () => {
  it('uses Turkish initials without changing dotted or dotless I', () => {
    expect(getCharacterInitials('İpek Çığ')).toBe('İÇ');
    expect(getCharacterInitials('ışık')).toBe('IŞ');
    expect(getCharacterInitials('  Özgür   Şahin  ')).toBe('ÖŞ');
    expect(getCharacterInitials('ÇĞİÖŞÜ')).toBe('ÇĞ');
    expect(getCharacterInitials('çğıöşü')).toBe('ÇĞ');
  });

  it('treats canonically equivalent Turkish letters as one display letter', () => {
    expect(getCharacterInitials('O\u0308zgu\u0308r S\u0327ahin')).toBe('ÖŞ');
    expect(getCharacterInitials('I\u0307pek C\u0327ıg\u0306')).toBe('İÇ');
    expect(getCharacterInitials('ğ')).toBe('Ğ');
    expect(getCharacterInitials('')).toBe('?');
    expect(getCharacterInitials(' \t\n ')).toBe('?');
    expect(getCharacterInitials('—')).toBe('?');
  });

  it('searches Turkish case and Unicode normalization across name and filename', () => {
    expect(matchesLiveSearch('  İPEK  ÇIĞ ', 'İpek', 'Çığ')).toBe(true);
    expect(matchesLiveSearch('istanbul', 'İSTANBUL')).toBe(true);
    expect(matchesLiveSearch('ışık', 'IŞIK')).toBe(true);
    expect(matchesLiveSearch('özgür', 'O\u0308zgu\u0308r')).toBe(true);
    expect(matchesLiveSearch('şölen', undefined, null, 'ŞÖLEN.rrf')).toBe(true);
    expect(matchesLiveSearch('', null, undefined)).toBe(true);
    expect(matchesLiveSearch('  ', '')).toBe(true);
  });

  it('keeps real Turkish letter distinctions rather than inventing ASCII matches', () => {
    expect(matchesLiveSearch('isik', 'IŞIK')).toBe(false);
    expect(matchesLiveSearch('çığ', 'cig')).toBe(false);
    expect(matchesLiveSearch('i', 'I')).toBe(false);
    expect(matchesLiveSearch('ı', 'İ')).toBe(false);
  });

  it('describes all runtime statuses without implying a completed recording', () => {
    const statuses: LiveStreamStatus[] = ['queued', 'reading', 'analyzing', 'following', 'settled', 'paused', 'stopped', 'missing', 'error', 'resource-wait'];
    for (const status of statuses) {
      const text = liveStatusPresentation(status);
      expect(text.label).not.toBe('');
      expect(text.description).not.toBe('');
    }
    expect(liveStatusPresentation('settled').description).toContain('kaydın bittiği anlamına gelmez');
    expect(liveStatusPresentation('paused').tone).toBe('paused');
    expect(liveStatusPresentation('missing').tone).toBe('error');
    expect(liveStatusPresentation('resource-wait').tone).toBe('waiting');
  });

  it('formats resource sizes with Turkish numbers and correct decimal units', () => {
    expect(formatLiveBytes(0)).toBe('0 B');
    expect(formatLiveBytes(999)).toBe('999 B');
    expect(formatLiveBytes(1000)).toBe('1 KB');
    expect(formatLiveBytes(1500)).toBe('1,5 KB');
    expect(formatLiveBytes(1_500_000)).toBe('1,5 MB');
    expect(formatLiveBytes(1_024_000_000)).toBe('1 GB');
    expect(formatLiveBytes(Number.NaN)).toBe('—');
    expect(formatLiveBytes(Infinity)).toBe('—');
    expect(formatLiveBytes(-1)).toBe('—');
  });
  it('presents folder activity from validated Replay progress and leaves errors visible',()=>{
    const source={status:'following',sourceMode:'folder',lastActivityAt:'2099-01-01T00:00:00Z'} as LiveStreamState;
    expect(liveStatusPresentation(source)).toMatchObject({label:'Bekleniyor',tone:'waiting'});
    expect(liveStatusPresentation({...source,liveActivity:'waiting'})).toMatchObject({label:'Bekleniyor',tone:'waiting'});
    expect(liveStatusPresentation({...source,liveActivity:'live'})).toMatchObject({label:'Canlı',tone:'active'});
    expect(liveStatusPresentation({...source,liveActivity:'idle'})).toMatchObject({label:'Durdu',tone:'paused'});
    expect(liveStatusPresentation({...source,liveActivity:'live',status:'missing'})).toMatchObject({label:'Dosya bulunamadı',tone:'error'});
  });
});
