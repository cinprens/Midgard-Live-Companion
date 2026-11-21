import {MapPin, PackageOpen, Skull, Swords, Weight} from 'lucide-react';

export const GENERAL_ALERT_RULES = [
  {kind: 'card', scene: 'item', name: 'Eşya', icon: PackageOpen},
  {kind: 'monster', scene: 'monster', name: 'Yaratık ölümü', icon: Swords},
  {kind: 'weight', scene: 'weight', name: 'Çanta ağırlığı', icon: Weight},
  {kind: 'city', scene: 'city', name: 'Harita değişimi', icon: MapPin},
  {kind: 'death', scene: 'death', name: 'Karakter ölümü', icon: Skull},
] as const;
