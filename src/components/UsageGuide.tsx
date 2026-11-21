import { BookOpen, ChevronDown } from 'lucide-react';
import { MAX_SCENE_SECONDS, MIN_SCENE_SECONDS } from '../shared/scene-durations';
import { useLanguage } from '../i18n/language';

export default function UsageGuide() {
  const english = useLanguage() === 'en';
  return <section className="notice-guide" aria-labelledby="notice-guide-title">
    <h2 id="notice-guide-title"><BookOpen size={19} aria-hidden="true"/>Kullanım rehberi</h2>
    <details open>
      <summary>Üç karakterimi nasıl takip ederim?<ChevronDown size={16} aria-hidden="true"/></summary>
      <ol>
        {english ? <>
          <li>In the game, start a Replay recording on each character you want to track.</li>
          <li>Open <strong>Live tracking</strong> in MIDGARD. Click <strong>Choose Replay folder</strong> and select the folder where the game saves those recordings.</li>
          <li>Characters recording to the same folder appear on separate rows. <strong>Live</strong> means MIDGARD is receiving new data from that character’s recording.</li>
        </> : <>
          <li>Oyunda takip edeceğin her karakter için bir Replay kaydı başlat.</li>
          <li>MIDGARD’da <strong>Canlı takip</strong> sayfasını aç. <strong>Replay klasörünü seç</strong> düğmesine bas ve oyunun bu kayıtları yazdığı klasörü seç.</li>
          <li>Aynı klasöre kayıt yapan üç karakter ayrı satırlarda görünür. Bir satırda <strong>Canlı</strong> yazıyorsa o karakterin kaydından yeni bilgi geliyor.</li>
        </>}
      </ol>
    </details>
    <details>
      <summary>Kart veya kostüm düşünce nasıl ses alırım?<ChevronDown size={16} aria-hidden="true"/></summary>
      <ol>
        {english ? <>
          <li>Look at the speaker button at the top of this page. If it says <strong>Sound on</strong>, you’re ready. Otherwise, click it and raise the volume above zero.</li>
          <li>Under <strong>Card and costume sounds</strong>, open <strong>Cards</strong>. Next to <strong>Default card sound</strong>, click <strong>Choose sound</strong>, pick a file, then click <strong>Test</strong> to hear it.</li>
          <li>To give just <strong>Mobster Card</strong> a different sound, search for its name below. Click the matching card and choose a file. Other cards will keep the default card sound.</li>
          <li>Follow the same steps under <strong>Costumes</strong> for costume drops. If only one character is silent, check that character’s volume under <strong>Character settings</strong>.</li>
        </> : <>
          <li>Bu sayfanın üstündeki hoparlör düğmesine bak. <strong>Ses açık</strong> yazıyorsa hazırsın. Başka bir şey yazıyorsa düğmeye bas ve ses düzeyini sıfırın üzerine getir.</li>
          <li><strong>Kart ve kostüm sesleri</strong> altında <strong>Kartlar</strong> bölümünü aç. <strong>Genel kart sesi</strong> satırında <strong>Ses seç</strong> ile bir dosya seç. <strong>Dene</strong> düğmesine basıp sesi dinle.</li>
          <li>Örneğin yalnız <strong>Mobster Card</strong> için farklı bir ses istiyorsan alttaki aramaya adını yaz. Sonuçtaki karta tıkla ve dosyayı seç. Diğer kartlar genel sesi kullanır.</li>
          <li>Kostümler için aynı adımları <strong>Kostümler</strong> bölümünde uygula. Bir karakter sessiz kalıyorsa <strong>Karaktere özel ayarlar</strong> altında o karakterin ses düzeyini kontrol et.</li>
        </>}
      </ol>
    </details>
    <details>
      <summary>Eşya ve çanta uyarılarını nasıl ayarlarım?<ChevronDown size={16} aria-hidden="true"/></summary>
      <ol>
        {english ? <>
          <li>To track an item, go to <strong>Add an alert</strong> and select <strong>Item</strong>. Type an item name such as <strong>Fly Wing</strong> and click the matching result.</li>
          <li>For a weight warning, go to <strong>General rules</strong> and turn on <strong>Inventory weight</strong>. Click the row, enter a percentage and click <strong>Apply</strong>.</li>
          <li>To change how long an alert fills the compact panel, enter {MIN_SCENE_SECONDS} to {MAX_SCENE_SECONDS} seconds under <strong>Scene duration</strong> and click <strong>Save duration</strong>. Cards and costumes have their own duration settings.</li>
        </> : <>
          <li>Belirli bir eşya için <strong>Hızlı bildirim ekle</strong> bölümünde <strong>Eşya</strong> seç. Örneğin <strong>Fly Wing</strong> yaz ve sonuçtaki eşyaya tıkla.</li>
          <li>Çantan dolarken uyarı almak için <strong>Genel kurallar</strong> altında <strong>Çanta ağırlığı</strong> anahtarını aç. Satıra tıkla, istediğin yüzdeyi gir ve <strong>Uygula</strong> düğmesine bas.</li>
          <li>Uyarının küçük paneli kaç saniye kaplayacağını seçmek için ilgili kuralda <strong>Sahne süresi</strong> alanına {MIN_SCENE_SECONDS} ile {MAX_SCENE_SECONDS} arasında bir sayı yazıp <strong>Süreyi kaydet</strong> düğmesine bas. Kart ve kostüm süreleri de kendi bölümlerinden ayarlanır.</li>
        </>}
      </ol>
    </details>
    <details>
      <summary>Küçük Av Ekibi panelini nasıl kullanırım?<ChevronDown size={16} aria-hidden="true"/></summary>
      <ol>
        {english ? <>
          <li>Click <strong>Taskbar mode</strong> at the top. Drag the panel by its header to move it. Click the <strong>Always on top</strong> pin to keep it above other windows. Click the pin again to release it.</li>
          <li>Click <strong>Switch to vertical view</strong> to use the panel at the side of the screen. Click the same button again to return to the horizontal layout.</li>
          <li>The header shows the party’s daily totals. Click a character to see their totals instead. Click the same row again to return to the party totals.</li>
          <li><strong>Estimated Zeny</strong> is the value of today’s loot at the prices entered in Finance. <strong>Wallet</strong> is the last balance read from the Replay.</li>
          <li>Click <strong>Main window</strong> or press <kbd>Esc</kbd> to return to the full app. Click <strong>×</strong> to close the app.</li>
        </> : <>
          <li>Üstteki <strong>Görev çubuğu modu</strong> düğmesine bas. Paneli taşımak için başlığını tutup sürükle. <strong>Her zaman üstte</strong> raptiyesini açarsan panel diğer pencerelerin üstünde kalır. Serbest bırakmak için aynı düğmeye tekrar bas.</li>
          <li>Paneli yan tarafta kullanmak için <strong>Dikey görünüme geç</strong> düğmesine bas. Aynı yerden yatay görünüme dönebilirsin.</li>
          <li>Üstte ekibin günlük toplamları görünür. Bir karaktere tıklayınca başlık ve toplamlar ona geçer. Satıra tekrar tıklayınca ekip toplamları geri gelir.</li>
          <li><strong>Tahmini Zeny</strong>, bugün toplanan eşyaların Finans’taki fiyatlarla değeridir. <strong>Cüzdan</strong> ise Replay’de en son okunan bakiyedir.</li>
          <li>Büyük ekrana dönmek için <strong>Ana pencere</strong> düğmesine ya da <kbd>Esc</kbd> tuşuna bas. <strong>×</strong> uygulamayı kapatır.</li>
        </>}
      </ol>
    </details>
  </section>;
}
