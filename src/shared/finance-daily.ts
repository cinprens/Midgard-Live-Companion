import type {AutoFarmState} from './auto-farm';

export interface FinanceDailyQuery {date:string;characterKey?:string|null;}
export interface FinanceDailyDay {date:string;quantity:number;knownValue:number;partial:boolean;durationMs:number;durationPartial:boolean;}
export interface FinanceDailyState extends AutoFarmState {
  date:string;
  timeZone:'Europe/Istanbul';
  priceBasis:'current-shared-prices';
  days:FinanceDailyDay[];
  undatedQuantity:number;
  durationPartial:boolean;
}
