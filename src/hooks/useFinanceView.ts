import {useEffect,useMemo,useSyncExternalStore} from 'react';
import {FinanceViewPreferenceController,type FinanceViewAPI} from '../domain/finance-preferences';

export function useFinanceView(api:FinanceViewAPI|undefined=typeof window==='undefined'?undefined:window.midgard){
  const controller=useMemo(()=>new FinanceViewPreferenceController(api),[api]);
  const state=useSyncExternalStore(controller.subscribe,controller.snapshot,controller.snapshot);
  useEffect(()=>{controller.start();return()=>controller.dispose();},[controller]);
  return {...state,setView:controller.setView,retry:controller.retry};
}
