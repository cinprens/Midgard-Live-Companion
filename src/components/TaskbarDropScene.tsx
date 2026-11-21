import {serviceMessage} from '../i18n/catalog';
import type { LiveAppearanceId } from '../shared/live-appearance';
import { Skull } from 'lucide-react';
import type { GeneralTaskbarScene, TaskbarScene } from '../domain/taskbar-scenes';
import crest from '../assets/live/pixel-party/crest.webp';
import { LIVE_CHARACTER_ART, LIVE_LOOT_ART } from './live-adventure-assets';
import './TaskbarDropScene.css';

const number = new Intl.NumberFormat('tr-TR', {maximumFractionDigits:1});
const generalLabels = {
  item:'Çantaya geldi', city:'Harita değişimi', weight:'Çanta ağırlığı', death:'Karakter durumu', monster:'Yaratık ölümü',
};
const badges = {card:'VS', costume:'VS', item:'+', city:'→', weight:'!', death:'!', monster:'!'};

function generalTitle(scene:GeneralTaskbarScene) {
  if(scene.subject) return scene.subject;
  switch(scene.category) {
    case 'item': return scene.itemId ? `Eşya #${scene.itemId}` : 'Eşya alındı';
    case 'monster': return scene.monsterId ? `Yaratık #${scene.monsterId}` : 'Ölüm gözlendi';
    case 'death': return 'Karakter öldü';
    case 'weight': return scene.amount === undefined ? 'Eşiğe ulaşıldı' : `%${number.format(scene.amount)}`;
    case 'city': return serviceMessage(scene.message).replace(`${scene.character}: `,'');
  }
}

function SceneArt({category}:{category:TaskbarScene['category']}) {
  if(category==='card' || category==='costume' || category==='item'){
    return <img className="drop-art" src={LIVE_LOOT_ART[category==='item'?'generic':category]} alt="" draggable={false}/>;
  }
  if(category==='death')return <div className="drop-art scene-skull"><Skull strokeWidth={1.7}/></div>;
  const sprite={city:'compass',weight:'pack',monster:'swords'}[category];
  return <span className={`drop-art scene-sprite item-sprite sprite-${sprite}`}/>;
}

export default function TaskbarDropScene({ scene, appearance }: { scene: TaskbarScene; appearance: LiveAppearanceId | null }) {
  const rare='itemName' in scene;
  const label=rare ? (scene.category==='card'?'Kart düştü!':'Kostüm düştü!') : generalLabels[scene.category];
  const title=rare ? scene.itemName : generalTitle(scene);
  const amount=rare ? scene.quantity : (scene.category==='item' ? scene.amount : undefined);
  const detail=scene.category==='monster' ? 'Öldüren karakter bilinmiyor' :
    scene.category==='weight' && scene.threshold!==undefined ? `Uyarı eşiği %${number.format(scene.threshold)}` : undefined;
  return <section className="taskbar-drop-scene" data-category={scene.category} data-drop-id={scene.id}
    role="status" aria-live="polite" aria-atomic="true">
    <span className="drop-announcement">{rare ? `${label} ${scene.character}, ${number.format(scene.quantity)} adet ${scene.itemName} aldı.` :
      scene.category==='monster' ? `${scene.character} kaydında ${serviceMessage(scene.message)}` : serviceMessage(scene.message)}</span>
    <div className="drop-duel" aria-hidden="true">
      <div className="drop-fighter">
        <img className="drop-portrait" src={appearance ? LIVE_CHARACTER_ART[appearance] : crest} alt="" draggable={false}/>
        <div className="drop-fighter-name"><small>{scene.category==='monster'?'Gözlemci':rare?'Avcı':'Karakter'}</small><strong>{scene.character}</strong></div>
      </div>
      <div className="drop-versus"><b>{badges[scene.category]}</b></div>
      <div className="drop-prize">
        <div className="drop-prize-name"><small>{label}</small><strong>{title}</strong>
          {amount!==undefined && amount>1 && <span className="drop-quantity">×{number.format(amount)}</span>}
          {detail && <span className="drop-scene-detail">{detail}</span>}
        </div>
        <SceneArt category={scene.category}/>
      </div>
    </div>
  </section>;
}
