import {useEffect,useMemo,useSyncExternalStore} from 'react';
import {LiveViewPreferenceController,type LiveViewAPI} from '../domain/live-preferences';

export function useLiveView(api:LiveViewAPI|undefined=typeof window==='undefined'?undefined:window.midgard){
  const controller=useMemo(()=>new LiveViewPreferenceController(api),[api]);
  const state=useSyncExternalStore(controller.subscribe,controller.snapshot,controller.snapshot);
  useEffect(()=>{controller.start();return()=>controller.dispose();},[controller]);
  return {...state,setView:controller.setView,retry:controller.retry};
}
