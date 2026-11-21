import type {HuntAnalyticsMetrics,HuntAnalyticsReference,HuntAnalyticsState} from '../shared/hunt-analytics';

export type HuntSpan=[number,number];
export function unionHuntSpans(spans:HuntSpan[]):HuntSpan[] {
  const sorted=spans.filter(([start,end])=>Number.isFinite(start)&&Number.isFinite(end)&&end>start).map(span=>[...span] as HuntSpan).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const result:HuntSpan[]=[];
  for(const span of sorted){const tail=result.at(-1);if(tail&&span[0]<=tail[1])tail[1]=Math.max(tail[1],span[1]);else result.push(span);}
  return result;
}
export function intersectHuntSpans(a:HuntSpan[],b:HuntSpan[]):HuntSpan[] {
  const result:HuntSpan[]=[];let i=0,j=0;
  while(i<a.length&&j<b.length){const start=Math.max(a[i][0],b[j][0]),end=Math.min(a[i][1],b[j][1]);if(end>start)result.push([start,end]);if(a[i][1]<b[j][1])i++;else j++;}
  return result;
}
export function subtractHuntSpans(spans:HuntSpan[],removed:HuntSpan[]):HuntSpan[] {
  const result:HuntSpan[]=[];let j=0;
  for(const[start,end]of spans){let at=start;while(j<removed.length&&removed[j][1]<=start)j++;for(let k=j;k<removed.length&&removed[k][0]<end;k++){if(removed[k][0]>at)result.push([at,Math.min(end,removed[k][0])]);at=Math.max(at,removed[k][1]);if(at>=end)break;}if(at<end)result.push([at,end]);}
  return result;
}
/** Each input belongs to one independently recorded Replay; copied sources must already be united. */
export function overlappingHuntSpans(recordings:HuntSpan[][]):HuntSpan[] {
  const edges:Map<number,number>=new Map();for(const spans of recordings)for(const[start,end]of spans){edges.set(start,(edges.get(start)??0)+1);edges.set(end,(edges.get(end)??0)-1);}
  let count=0,previous:number|null=null;const result:HuntSpan[]=[];
  for(const[time,delta]of[...edges].sort((a,b)=>a[0]-b[0])){if(previous!==null&&count>1&&time>previous)result.push([previous,time]);count+=delta;previous=time;}
  return unionHuntSpans(result);
}
export function huntSpanContains(spans:HuntSpan[],time:number):boolean {let low=0,high=spans.length-1;while(low<=high){const middle=(low+high)>>>1,span=spans[middle];if(time<span[0])high=middle-1;else if(time>=span[1])low=middle+1;else return true;}return false;}
export function huntSpanCovers(spans:HuntSpan[],start:number,end:number):boolean {return spans.some(span=>span[0]<=start&&span[1]>end);}
export function huntSpanDuration(spans:HuntSpan[]):number{return spans.reduce((total,[start,end])=>total+end-start,0);}
export function huntRate(observations:number,durationMs:number):number|null{return durationMs>=600000?observations*3600000/durationMs:null;}

export function compareHuntMetrics(current:HuntAnalyticsMetrics,reference:HuntAnalyticsMetrics,kind:HuntAnalyticsReference,trackedDays:number,partial:boolean):HuntAnalyticsState['comparison'] {
  let reason:string|null=null;
  if(partial)reason='Kısmi kayıt: karşılaştırma için saat ve kapsamın eksiksiz olması gerekir.';
  else if(reference.durationMs===0)reason='Referans dönemde uygun takip kaydı yok.';
  else if(reference.observations===0)reason='Önceki dönemde gözlem yok.';
  else if(current.durationMs<1800000||current.observations<10)reason='Karşılaştırma için bu dönemde en az 30 dakika ve 10 gözlem gerekiyor.';
  else if(kind==='previous-day'&&(reference.durationMs<1800000||reference.observations<10))reason='Dün karşılaştırması için iki dönemde de en az 30 dakika ve 10 gözlem gerekiyor.';
  else if(kind==='previous-7-days'&&(trackedDays<3||reference.durationMs<7200000||reference.observations<20))reason='Referans için en az 3 kayıtlı gün, toplam 120 dakika ve 20 gözlem gerekiyor.';
  const eligible=reason===null;
  return{eligible,reason,rateChangePercent:eligible?((current.observations/current.durationMs)/(reference.observations/reference.durationMs)-1)*100:null,countChangePercent:eligible&&kind==='previous-day'?(current.observations/reference.observations-1)*100:null,referenceEquivalentCount:reference.durationMs>0&&current.durationMs>0?reference.observations/reference.durationMs*current.durationMs:null};
}
const percent=new Intl.NumberFormat('tr-TR',{maximumFractionDigits:1});
export function huntInsight(comparison:HuntAnalyticsState['comparison'],current:HuntAnalyticsMetrics,partial:boolean):string {
  if(partial)return 'Kısmi kayıt var; tempo değişimi gösterilmiyor.';
  if(comparison.reason)return comparison.reason;
  if(current.ratePerHour===null)return 'Hız için en az 10 dakika uygun takip birikiyor.';
  const rate=comparison.rateChangePercent,count=comparison.countChangePercent;
  if(rate===null)return 'Karşılaştırma için takip birikiyor.';
  if(count!==null&&count>0&&rate<0)return `Gözlem adedi %${percent.format(count)} arttı; saatlik tempo %${percent.format(Math.abs(rate))} azaldı.`;
  if(Math.abs(rate)<5)return 'Referans dönemle benzer tempo.';
  return `Saatlik gözlem temposu referansa göre %${percent.format(Math.abs(rate))} ${rate>0?'arttı':'azaldı'}.`;
}
export function huntQuantile(values:number[],quantile:number):number|null {if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),at=(sorted.length-1)*quantile,low=Math.floor(at),high=Math.ceil(at);return sorted[low]+(sorted[high]-sorted[low])*(at-low);}
