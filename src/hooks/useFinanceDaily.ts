import {useEffect,useRef,useState} from 'react';
import type {FinanceDailyQuery,FinanceDailyState} from '../shared/finance-daily';

/** Date changes immediately clear the prior slice; only a matching request can publish. */
export function useFinanceDaily(query:FinanceDailyQuery|null,revision=0){
  const key=JSON.stringify(query),queryRef=useRef(query);queryRef.current=query;
  const [retry,setRetry]=useState(0),[result,setResult]=useState<{key:string;data?:FinanceDailyState;error?:string;loading:boolean}>({key,loading:!!query});
  useEffect(()=>{
    if(!queryRef.current)return;
    const request=queryRef.current;let active=true,timer:ReturnType<typeof setTimeout>|undefined;
    setResult(previous=>previous.key===key&&previous.data?{...previous,error:undefined,loading:false}:{key,loading:true});
    const run=async()=>{
      try{
        const api=window.midgard as unknown as {getFinanceDaily?:(query:FinanceDailyQuery)=>Promise<FinanceDailyState>};
        if(!api?.getFinanceDaily)throw new Error('Günlük finans bağlantısı hazır değil. Uygulamayı yeniden açıp deneyebilirsin.');
        const data=await api.getFinanceDaily(request);if(active)setResult({key,data,loading:false});
      }catch(error){if(active)setResult({key,error:error instanceof Error?error.message:'Günlük finans okunamadı.',loading:false});}
      finally{if(active)timer=setTimeout(()=>void run(),5000);}
    };
    void run();return()=>{active=false;clearTimeout(timer);};
  },[key,revision,retry]);
  return{...(!query?{loading:false,data:undefined,error:undefined}:result.key===key?result:{loading:true,data:undefined,error:undefined}),refresh:()=>setRetry(value=>value+1)};
}
