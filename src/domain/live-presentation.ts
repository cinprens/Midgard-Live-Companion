import type { LiveStreamState,LiveStreamStatus } from '../shared/types';

export interface LiveStatusPresentation {
  label: string;
  description: string;
  tone: 'active' | 'waiting' | 'paused' | 'error';
}

const graphemes = new Intl.Segmenter('tr-TR', { granularity: 'grapheme' });
const normalizeText = (value: string): string => value.normalize('NFC').trim().replace(/\s+/gu, ' ');
const searchableText = (value: string): string => normalizeText(value).toLocaleLowerCase('tr-TR');

/** Display initials only; the recorded identity and spelling remain unchanged. */
export function getCharacterInitials(name: string): string {
  const words = normalizeText(name).split(' ').map(word =>
    Array.from(graphemes.segment(word), part => part.segment).filter(part => /[\p{L}\p{N}]/u.test(part)),
  ).filter(word => word.length > 0);
  if (!words.length) return '?';
  const letters = words.length > 1
    ? [words[0][0], words[words.length - 1][0]]
    : words[0].slice(0, 2);
  return letters.join('').toLocaleUpperCase('tr-TR').normalize('NFC');
}

/** Turkish case rules preserve the distinction between dotted and dotless I. */
export function matchesLiveSearch(query: string, ...values: (string | undefined | null)[]): boolean {
  const needle = searchableText(query);
  if (!needle) return true;
  return searchableText(values.filter((value): value is string => typeof value === 'string').join(' ')).includes(needle);
}

const statuses: Record<LiveStreamStatus, LiveStatusPresentation> = {
  queued: { label: 'Sırada', description: 'Bu kayıt için inceleme sırası bekleniyor.', tone: 'waiting' },
  reading: { label: 'Okunuyor', description: 'Seçtiğin kayıt dosyası okunuyor.', tone: 'active' },
  analyzing: { label: 'İnceleniyor', description: 'Okunan görüntüdeki desteklenen olaylar inceleniyor.', tone: 'active' },
  following: { label: 'Takip ediliyor', description: 'Dosyadaki yeni değişiklikler bekleniyor.', tone: 'active' },
  settled: { label: 'Son okuma hazır', description: 'Dosya bir süredir değişmedi. Bu durum kaydın bittiği anlamına gelmez.', tone: 'active' },
  paused: { label: 'Duraklatıldı', description: 'Bu kayıt sen devam ettirene kadar okunmayacak.', tone: 'paused' },
  stopped: { label: 'Durduruldu', description: 'Dosya takibi durduruldu. Önceki arşiv sonuçları korunur.', tone: 'paused' },
  missing: { label: 'Dosya bulunamadı', description: 'Dosya taşınmış veya yeniden adlandırılmış olabilir. Diğer kayıtların takibi sürer.', tone: 'error' },
  error: { label: 'İncelenemedi', description: 'Bu kayıt şu anda okunamadı veya incelenemedi. Ayrıntılardaki açıklamayı kontrol et.', tone: 'error' },
  'resource-wait': { label: 'Yer açılması bekleniyor', description: 'Bu kayıt, inceleme için ayrılan bellek bütçesinde yer açılmasını bekliyor.', tone: 'waiting' },
};

export function liveStatusPresentation(value:LiveStreamStatus|LiveStreamState):LiveStatusPresentation {
  const status=typeof value==='string'?value:value.status;
  if(typeof value!=='string'&&!['paused','stopped','missing','error','resource-wait'].includes(status)&&(value.sourceMode==='folder'||value.liveActivity)){
    if(value.liveActivity==='live')return{label:'Canlı',description:'Replay kaydında yeni geçerli paketler ilerliyor.',tone:'active'};
    if(value.liveActivity==='idle')return{label:'Durdu',description:'Replay verisi ilerlemiyor. Son doğru değerler korunuyor; yeni veri geldiğinde takip otomatik devam eder.',tone:'paused'};
    return{label:'Bekleniyor',description:'Canlı takip için Replay kaydında yeni geçerli veri bekleniyor.',tone:'waiting'};
  }
  return { ...statuses[status] };
}

/** Decimal units keep KB/MB labels accurate and familiar in the visitor interface. */
export function formatLiveBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  const formatted = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
  return `${formatted} ${units[unit]}`;
}
