import {describe,it,expect} from 'vitest';
import {characterLegacyForSave} from '../src/components/CharacterAlertSettings';
describe('selected monster preference inheritance',()=>{
  it('does not freeze an implicitly inherited global selection when saving another field',()=>{const draft={weightThreshold:68,volume:31,selectedCardIds:[4317],selectedMonsterIds:[1313]};const saved=characterLegacyForSave(draft,undefined);expect(saved).toEqual({weightThreshold:68,volume:31,selectedCardIds:[4317]});expect(draft.selectedMonsterIds).toEqual([1313]);});
  it('preserves a previously explicit selection including an intentionally empty one',()=>{for(const ids of [[1313,1002],[]])expect(characterLegacyForSave({weightThreshold:68,selectedMonsterIds:ids},{selectedMonsterIds:ids})).toEqual({weightThreshold:68,selectedMonsterIds:ids});});
});
