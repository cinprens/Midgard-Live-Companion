const zeny = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const shortZeny = new Intl.NumberFormat('tr-TR', { notation: 'compact', maximumFractionDigits: 1 });

export function taskbarEstimateText(value: number | null, partial: boolean) {
  if (value == null) return partial ? 'Fiyat bekleniyor' : '—';
  return `≈${zeny.format(value)} Z${partial ? '*' : ''}`;
}

export function taskbarShortEstimate(value: number | null, partial: boolean) {
  return value != null && value >= 100_000 ? `≈${shortZeny.format(value)} Z${partial ? '*' : ''}` : undefined;
}

export function taskbarEstimateHint(value: number | null, partial: boolean) {
  if (value == null) return partial ? 'Bugünkü ganimet için Finans’ta birim fiyat bekleniyor.' : 'Günlük ganimet verisi bekleniyor.';
  return partial ? 'Kısmi tahmin. Bugünkü ganimetin yalnızca fiyatı bilinen bölümü toplandı. Bazı fiyatlar veya karakter verileri eksik.'
    : 'Bugün toplanan adetler, Finans’taki ortak birim fiyatlarla çarpıldı.';
}
