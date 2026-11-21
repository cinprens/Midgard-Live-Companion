import {useEffect,useMemo,useSyncExternalStore} from 'react';
import {KillViewPreferenceController,type KillViewAPI} from '../domain/kill-preferences';

export function useKillView(api:KillViewAPI|undefined=typeof window==='undefined'?undefined:window.midgard){
  const controller=useMemo(()=>new KillViewPreferenceController(api),[api]);
  const state=useSyncExternalStore(controller.subscribe,controller.snapshot,controller.snapshot);
  useEffect(()=>{controller.start();return()=>controller.dispose();},[controller]);
  return {...state,setView:controller.setView,retry:controller.retry};
}
