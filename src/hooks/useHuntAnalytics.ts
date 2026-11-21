import {useCallback,useEffect,useRef,useState} from 'react';
import type {HuntAnalyticsEvidencePage,HuntAnalyticsEvidenceQuery,HuntAnalyticsQuery,HuntAnalyticsState} from '../shared/hunt-analytics';
import {createDefaultHuntAnalyticsPreferences,validateHuntAnalyticsPreferences,type HuntAnalyticsPreferences} from '../shared/hunt-analytics-preferences';

interface AnalyticsAPI {
  getHuntAnalytics(query:HuntAnalyticsQuery):Promise<HuntAnalyticsState>;
  getHuntAnalyticsEvidence(query:HuntAnalyticsEvidenceQuery):Promise<HuntAnalyticsEvidencePage>;
  getHuntAnalyticsPreferences():Promise<HuntAnalyticsPreferences>;
  setHuntAnalyticsPreferences(value:HuntAnalyticsPreferences):Promise<HuntAnalyticsPreferences>;
}
export function huntAnalyticsAPI():AnalyticsAPI {
  const api=typeof window==='undefined'?undefined:window.midgard as unknown as AnalyticsAPI;
  if(!api?.getHuntAnalytics||!api.getHuntAnalyticsEvidence)throw new Error('Av analizi bağlantısı hazır değil. Uygulamayı yeniden açıp deneyebilirsin.');
  return api;
}

/** Only a matching query can supply visible data; slow requests never overwrite a new scope. */
export function useHuntAnalytics(query:HuntAnalyticsQuery|null):{data?:HuntAnalyticsState;error?:string;loading:boolean;refresh:()=>void} {
  const key=JSON.stringify(query),queryRef=useRef(query);queryRef.current=query;
  const [retry,setRetry]=useState(0),[state,setState]=useState<{key:string;data?:HuntAnalyticsState;error?:string;loading:boolean}>({key,loading:!!query});
  useEffect(()=>{
    if(!queryRef.current)return;
    let active=true,timer:ReturnType<typeof setTimeout>|undefined;
    const current=queryRef.current;
    setState({key,loading:true});
    const run=async()=>{
      try{const data=await huntAnalyticsAPI().getHuntAnalytics(current);if(active)setState({key,data,loading:false});}
      catch(error){if(active)setState({key,loading:false,error:error instanceof Error?error.message:'Av analizi okunamadı.'});}
      finally{if(active)timer=setTimeout(()=>void run(),5000);}
    };
    void run();return()=>{active=false;clearTimeout(timer);};
  },[key,retry]);
  return{...(!query?{loading:false}:state.key===key?state:{loading:true}),refresh:()=>setRetry(value=>value+1)};
}

export function useHuntAnalyticsPreferences() {
  const [view,setView]=useState(createDefaultHuntAnalyticsPreferences),[ready,setReady]=useState(false),[error,setError]=useState<string>(),[retry,setRetry]=useState(0);
  const saved=useRef(''),tail=useRef(Promise.resolve()),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    if(ready)return;
    let active=true;
    Promise.resolve().then(()=>huntAnalyticsAPI().getHuntAnalyticsPreferences()).then(value=>{
      if(!active)return;const validated=validateHuntAnalyticsPreferences(value);saved.current=JSON.stringify(validated);setView(validated);setReady(true);setError(undefined);
    }).catch(reason=>{if(active)setError(reason instanceof Error?reason.message:'Analiz tercihleri okunamadı.');});
    return()=>{active=false;};
  },[ready,retry]);
  useEffect(()=>{
    const serialized=JSON.stringify(view);if(!ready||serialized===saved.current)return;
    let active=true;
    tail.current=tail.current.catch(()=>undefined).then(async()=>{
      await huntAnalyticsAPI().setHuntAnalyticsPreferences(view);saved.current=serialized;
      if(active&&mounted.current)setError(undefined);
    }).catch(reason=>{if(active&&mounted.current)setError(reason instanceof Error?reason.message:'Analiz tercihi kaydedilemedi.');});
    return()=>{active=false;};
  },[ready,view,retry]);
  const update=useCallback((patch:Partial<HuntAnalyticsPreferences>)=>setView(previous=>validateHuntAnalyticsPreferences({...previous,...patch})),[]);
  return{view,ready,error,update,retry:()=>setRetry(value=>value+1)};
}
