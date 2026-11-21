import {serviceMessage} from '../i18n/catalog';
import {currentLanguage} from '../i18n/locale';
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, CircleHelp, CircleStop, Clock3, FilePlus2, FolderPlus, Gem, MapPin, Pause, Play, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Trash2, TriangleAlert, Users } from 'lucide-react';
import type { AppState, DesktopAPI, LiveStreamState, ReplayRecord } from '../shared/types';
import { compareCharacters } from '../domain/characters';
import { number } from '../domain/analytics';
import { formatLiveBytes, getCharacterInitials, liveStatusPresentation, matchesLiveSearch } from '../domain/live-presentation';
import CharacterBinding from './CharacterBinding';
import CharacterComparison from './CharacterComparison';
import observatory from '../assets/live/observatory.svg';
import characterCrest from '../assets/live/character-crest.svg';
import lootCache from '../assets/live/loot-cache.svg';

type Run = (operation: (api: DesktopAPI) => Promise<unknown>) => void;
type Filter = 'all' | 'following' | 'paused';
const isFollowing = (stream: LiveStreamState) => !['paused', 'stopped', 'missing', 'error'].includes(stream.status);
const streamName = (stream: LiveStreamState) => (stream.character?.source === 'unassigned' ? 'Karakter adı bekleniyor' : stream.character?.name || stream.summary?.characterName || 'Karakter adı bekleniyor').normalize('NFC');

export function streamRecords(state: AppState): ReplayRecord[] {
  return (state.live?.streams ?? []).filter(stream => stream.summary).map(stream => ({
    id: `stream:${stream.id}`, filename: stream.filename, hash: stream.contentHash ?? stream.id,
    size: stream.fileSize, importedAt: stream.lastActivityAt ?? new Date().toISOString(),
    status: 'analyzed', format: 'Deneysel RRF görüntüsü', version: '5 / Skadi doğrulanmadı',
    summary: stream.summary, character: stream.character, error: null,
    diagnostics: stream.diagnostics, overlapExcluded: false,
  }));
}

export default function LivePanel({ state, busy, run }: { state: AppState; busy: boolean; run: Run }) {
  const live = state.live;
  const allStreams = live?.streams ?? [];
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(0);
  const [showComparison, setShowComparison] = useState(false);
  const comparison = useMemo(() => compareCharacters(streamRecords(state)), [live]);
  const streams = allStreams.filter(stream => matchesLiveSearch(search, stream.filename, stream.character?.name, stream.summary?.characterName, stream.summary?.mapName) && (filter === 'all' || (filter === 'following' ? isFollowing(stream) : ['paused', 'stopped'].includes(stream.status))));
  useEffect(() => setPage(0), [search, filter]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(streams.length / 24) - 1));
  const visibleStreams = streams.slice(currentPage * 24, (currentPage + 1) * 24);
  const choices = [...(state.manualCharacters ?? []), ...(state.comparison?.characters.map(character => character.identity) ?? [])];
  const followingCount = allStreams.filter(isFollowing).length;
  const itemSummary = comparison.itemObservations;

  return <div className="live-workspace" lang="tr">
    <section className="live-showcase" aria-labelledby="live-showcase-title">
      <img className="live-showcase-art" src={observatory} alt="" aria-hidden="true" />
      <div className="live-showcase-copy">
        <span className="live-section-kicker"><span /> ÇOKLU KARAKTER MASASI</span>
        <h2 id="live-showcase-title">Karakterlerin bir arada.<br /><em>Ganimet gözlemlerin önde.</em></h2>
        <p>Kayıtlarını ekle, her karakterin son durumunu ve eşya gözlemlerini kendi kartında takip et.</p>
        <div className="live-showcase-status"><span className="live-experiment"><ShieldCheck size={15} /> Deneysel · Skadi doğrulanmadı</span><span>Yalnızca seçtiğin dosyalar okunur.</span></div>
      </div>
    </section>
    <div className="live-primary-actions">
      <div className="live-action-group">
        <button className="button primary" disabled={busy} onClick={() => run(api => api.addLiveFiles())}><FilePlus2 size={18} /> Kayıt ekle (.rrf)</button>
        <button className="button secondary" disabled={busy} onClick={() => run(api => api.addLiveFolder(false))}><FolderPlus size={18} /> Klasörden ekle</button>
        <button className="button secondary live-scan-button" disabled={busy || !live?.discovery.folder} onClick={() => run(api => api.refreshLive())}><RefreshCw size={17} /> Yeni dosyaları tara</button>
      </div>
      <details className="live-inline-help"><summary><CircleHelp size={17} /> Bu ekran neyi gösteriyor?</summary><div>
        <strong>Dosya takibi açık, oyunla canlı uyumluluk doğrulanmadı.</strong>
        <p>Dosyaya yeni veri geldikçe desteklenen bilgiler güncellenir. İlk açılışta mevcut geçmiş sessizce okunur. Skadi için sonuçları gerçek oyun kaydıyla doğrulamak gerekir.</p>
        <p><b>Envanter bildirimi:</b> Eşyaya ilişkin başarılı ekleme bildiriminin adetidir. Satın alma, ödül veya mevcut eşyanın yeniden gösterimi olabilir; net yeni ganimet değildir.</p>
        <p><b>Yerdeki eşya:</b> Kayıtta görülen eşya gözlemidir. Aynı eşya farklı karakterlerin kayıtlarında da görünebilir.</p>
        <p><b>Kişisel drop:</b> Eşyanın sana ait yaratık ganimeti olduğu kanıtlanmadığı için “Doğrulanmadı” gösterilir.</p>
      </div></details>
    </div>
    {allStreams.length > 0 && <section className="live-observation-overview" aria-label="Seçili kayıtların eşya gözlemleri">
      <div className="live-observation-tile featured"><img src={lootCache} alt="" /><div><span>Envanter bildirimi</span><strong>{itemSummary ? number(itemSummary.obtainedQuantity) : '—'} <small>adet</small></strong><p>Bildirim adedi; net ganimet değildir.</p></div></div>
      <div className="live-observation-tile"><span className="live-tile-symbol"><Gem size={26} /></span><div><span>Yerde eşya gözlemi</span><strong>{itemSummary ? number(itemSummary.groundCount) : '—'}</strong><p>Karakterler arasında tekrar içerebilir.</p></div></div>
      <div className="live-observation-tile certainty"><span className="live-tile-symbol"><ShieldCheck size={25} /></span><div><span>Kişisel drop</span><strong>{comparison.drops == null ? 'Doğrulanmadı' : number(comparison.drops)}</strong><p>Kesin sahiplik kanıtı bekleniyor.</p></div></div>
    </section>}
    <div className="live-roster-heading"><div><h2>Karakter kayıtların <span>{allStreams.length}</span></h2><p>{allStreams.length ? `${followingCount} kayıt izleniyor. Her kart ayrı bir dosyaya aittir.` : 'Bir veya daha fazla .rrf dosyasıyla başlayabilirsin.'}</p></div><label className="live-roster-search"><Search size={18} /><input aria-label="Akış ara" placeholder="Karakter, harita veya kayıt ara…" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
    {allStreams.length > 0 && <div className="live-roster-filters" role="group" aria-label="Kayıt durumuna göre filtrele">{([{ id: 'all', label: 'Tüm kayıtlar' }, { id: 'following', label: 'İzlenenler' }, { id: 'paused', label: 'Duraklatılanlar' }] as const).map(option => <button key={option.id} aria-pressed={filter === option.id} className={filter === option.id ? 'selected' : ''} onClick={() => setFilter(option.id)}>{option.label}</button>)}</div>}
    {streams.length > 0 ? <div className="live-roster-grid">{visibleStreams.map((stream, index) => {
      const name = streamName(stream), presentation = liveStatusPresentation(stream.status);
      const watching = !['paused', 'stopped'].includes(stream.status), summary = stream.summary, items = summary?.itemObservations;
      const initials = stream.character?.source === 'unassigned' || !summary?.characterName && !stream.character?.name ? '?' : getCharacterInitials(name);
      return <section className={`stream-card live-character-card tone-${presentation.tone} accent-${index % 3}`} key={stream.id} data-stream-id={stream.id}>
        <header className="live-character-heading"><div className="live-character-emblem" aria-hidden="true"><img src={characterCrest} alt="" /><span>{initials}</span></div><div className="live-character-title"><h3 title={name}>{name}</h3><p><MapPin size={13} /><span>{summary?.mapName || 'Harita bilgisi bekleniyor'}</span></p></div></header>
        <div className={`live-character-status ${presentation.tone}`} title={presentation.description}><span /><strong>{presentation.label}</strong><small><Clock3 size={13} /> {stream.lastActivityAt ? new Date(stream.lastActivityAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : 'Henüz okunmadı'}</small></div>
        <div className="live-character-loot"><img src={lootCache} alt="" /><div><span>Envanter bildirimi</span><strong>{items ? number(items.obtainedQuantity) : '—'} <small>adet</small></strong></div><Gem size={17} className="live-loot-corner" /></div>
        <p className="live-notification-caption">Bildirim adedi; net yeni ganimet değildir.</p>
        <div className="live-character-metrics"><div><span>Yerde eşya</span><strong>{items ? number(items.groundCount) : '—'}</strong></div><div><span>Gözlenen ölüm</span><strong>{summary ? number(summary.deaths) : '—'}</strong></div><div><span title="Kayıt sahibine atanabilen hasar. Eksik oyuncu kimliği manuel isimle tamamlanmaz.">Karakter hasarı</span><strong>{summary?.playerId != null ? number(summary.damage) : '—'}</strong></div></div>
        <div className="live-personal-loot"><ShieldCheck size={14} /><span>Kişisel drop</span><strong>{summary?.drops == null ? 'Doğrulanmadı' : number(summary.drops)}</strong></div>
        <div className="live-card-disclosures">
          <details className="live-card-disclosure live-binding-disclosure"><summary><Users size={15} /><span>Karakteri eşleştir</span><ChevronDown size={15} /></summary><CharacterBinding identity={stream.character} choices={choices} disabled={busy} onSave={value => run(api => api.assignCharacter({ kind: 'stream', id: stream.id }, value))} /></details>
          <details className="live-card-disclosure live-record-disclosure"><summary><SlidersHorizontal size={15} /><span>Kayıt ayrıntıları</span><ChevronDown size={15} /></summary><div className="live-record-details"><p className="live-status-explanation">{presentation.description}</p><dl><dt>Dosya</dt><dd>{stream.filename}</dd><dt>Okunan veri</dt><dd>{formatLiveBytes(stream.readPosition)} / {formatLiveBytes(stream.fileSize)}</dd><dt>Görüntü sürümü</dt><dd>{stream.revision}</dd><dt>Paket / olay</dt><dd>{number(stream.packetCount)} / {number(stream.eventCount)}</dd><dt>EXP</dt><dd>{summary?.exp == null ? 'Doğrulanmadı' : number(summary.exp)}</dd><dt>Dosya konumu</dt><dd>{stream.sourcePath}</dd></dl><p>Dosyanın tamamen okunması, kaydın sona erdiğini kanıtlamaz.</p>{!!stream.diagnostics.length && <details className="live-diagnostic-list"><summary>Tanılama mesajları ({stream.diagnostics.length})</summary>{stream.diagnostics.map((diagnostic, i) => <p key={i}>{serviceMessage(diagnostic)}</p>)}</details>}</div></details>
        </div>
        <div className="live-card-actions"><button className="button secondary" disabled={busy} onClick={() => run(api => api.controlLive(stream.id, watching ? 'pause' : 'resume'))}>{watching ? <Pause size={15} /> : <Play size={15} />}{watching ? 'Duraklat' : 'Devam et'}</button><button className="button secondary" disabled={busy || stream.status === 'stopped'} onClick={() => run(api => api.controlLive(stream.id, 'stop'))}><CircleStop size={15} /> Durdur</button><button className="button live-remove-button" aria-label={`${stream.filename} akışını kaldır`} title="Kaydı listeden kaldır; dosya silinmez." disabled={busy} onClick={() => run(api => api.controlLive(stream.id, 'remove'))}><Trash2 size={16} /></button></div>
      </section>;
    })}</div> : <div className="live-friendly-empty"><img src={characterCrest} alt="" /><h3>{search || filter !== 'all' ? 'Bu filtreyle eşleşen kayıt yok' : 'İlk karakter kaydını ekleyelim'}</h3><p>{search || filter !== 'all' ? 'Aramayı veya durum filtresini değiştirerek diğer kayıtlarını görebilirsin.' : 'Dosyanı seçtiğinde karakter, eşya gözlemleri ve izleme durumu burada görünür.'}</p>{!allStreams.length && <div className="live-start-steps"><span><b>1</b> .rrf dosyanı seç</span><span><b>2</b> Karakterini kontrol et</span><span><b>3</b> Eşya gözlemlerini incele</span></div>}</div>}
    {streams.length > 24 && <div className="stream-pagination"><button className="button secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Önceki</button><span>{currentPage * 24 + 1}–{Math.min((currentPage + 1) * 24, streams.length)} / {streams.length} kayıt</span><button className="button secondary" disabled={(currentPage + 1) * 24 >= streams.length} onClick={() => setPage(currentPage + 1)}>Sonraki</button></div>}
    <details className="live-extended-panel live-comparison-disclosure" onToggle={event => setShowComparison(event.currentTarget.open)}><summary><Users size={19} /><span><strong>Karakterleri karşılaştır</strong><small>Ölüm, hasar ve belirsiz toplamları birlikte incele.</small></span><span className="live-detail-count">{comparison.characters.length} karakter</span><ChevronDown size={18} /></summary><div className="live-extended-body">{showComparison && <CharacterComparison data={comparison} provisional />}</div></details>
    <details className="live-extended-panel live-runtime-disclosure"><summary><Settings2 size={19} /><span><strong>Gelişmiş izleme bilgileri</strong><small>Dosya keşfi, işlem sırası ve kaynak kullanımı.</small></span><ChevronDown size={18} /></summary><div className="live-extended-body"><div className="live-runtime-grid"><div><span>İncelenen dosya</span><strong>{live?.activeWorkers ?? 0} / {live?.limits.maxWorkers ?? '—'}</strong></div><div><span>Sırada bekleyen</span><strong>{live?.queuedCount ?? 0}</strong></div><div><span>Ayrılan tampon / bütçe</span><strong>{formatLiveBytes(live?.bufferedBytes ?? 0)} / {formatLiveBytes(live?.limits.memoryBudgetBytes ?? 0)}</strong></div></div><div className="live-runtime-notice"><FolderPlus size={18} /><p><strong>Yeni dosyaları otomatik bulma: {live?.discovery.enabled ? (currentLanguage() === 'en' ? 'On' : 'Açık') : 'Kapalı'}.</strong> {serviceMessage(live?.discovery.blockedReason) || 'Gravity uygunluğu doğrulanana kadar kapalıdır. Seçtiğin klasördeki yeni dosyaları “Yeni dosyaları tara” ile ekleyebilirsin.'}</p></div><div className="live-runtime-notice"><TriangleAlert size={18} /><p>Bu ekran deneysel dosya görüntülerini gösterir. Akış ayrıntıları bellek için 1.000 eşya ve 1.000 yaratık türüyle sınırlandırılır; toplam sayaçlar korunur. Geçici akışlar, arşiv sonuçlarına ayrıca eklenerek çift sayılmaz.</p></div></div></details>
  </div>;
}
