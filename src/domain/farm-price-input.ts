export interface ParsedFarmPrice {value:number|null;valid:boolean;}

/** Turkish grouped thousands use dots; one/two decimal digits accept comma or legacy dot. */
export function parseFarmPriceInput(text:string):ParsedFarmPrice{
  const trimmed=text.trim();
  if(!trimmed)return{value:null,valid:true};
  if(trimmed.length>64)return{value:null,valid:false};
  let normalized:string;
  if(trimmed.includes(',')&&trimmed.includes('.')){
    if(!/^\d{1,3}(?:\.\d{3})+,\d{0,2}$/.test(trimmed))return{value:null,valid:false};
    normalized=trimmed.replaceAll('.','').replace(',','.');
  }else if(trimmed.includes(',')){
    if(!/^\d+,\d{0,2}$/.test(trimmed))return{value:null,valid:false};
    normalized=trimmed.replace(',','.');
  }else if(/^\d{1,3}(?:\.\d{3})+$/.test(trimmed))normalized=trimmed.replaceAll('.','');
  else{
    if(!/^\d+(?:\.\d{0,2})?$/.test(trimmed))return{value:null,valid:false};
    normalized=trimmed;
  }
  const value=Number(normalized);
  return Number.isFinite(value)&&value>=0&&value<=1e12?{value,valid:true}:{value:null,valid:false};
}

const formatter=new Intl.NumberFormat('tr-TR',{maximumFractionDigits:2});
export function formatFarmPriceInput(value:number|null):string{return value===null?'':formatter.format(value);}
