import {describe,it,expect} from 'vitest';
import {parseFarmPriceInput,formatFarmPriceInput} from '../src/domain/farm-price-input';

describe('manual Zeny price notation',()=>{
  it.each([
    ['35000',35000],['35.000',35000],['35.000,50',35000.5],['1.000.000',1000000],
    ['1,5',1.5],['1.5',1.5],['35.00',35],['0',0],['0,00',0],['0.00',0],
    [' 35000 ',35000],['1.000.000.000.000',1e12],['35000,',35000],['35000.',35000],
  ])('parses %s as its explicit numeric price',(text,value)=>{expect(parseFarmPriceInput(text as string)).toEqual({value,valid:true});});
  it.each(['',' ','\t'])('keeps an empty price unknown instead of zero',text=>{expect(parseFarmPriceInput(text)).toEqual({value:null,valid:true});});
  it.each(['35,000','35.00.0','1,000.50','1234.567','35.000,500','1.000.000.000.000,01','-1','1e3','NaN','Infinity','1_000','35 000','.50',',50','1'.repeat(65)])('rejects invalid or ambiguous notation %s',text=>{expect(parseFarmPriceInput(text).valid).toBe(false);});
  it('formats known values without turning null into a number',()=>{expect(formatFarmPriceInput(null)).toBe('');expect(formatFarmPriceInput(35000)).toBe('35.000');expect(formatFarmPriceInput(35000.5)).toBe('35.000,5');expect(formatFarmPriceInput(0)).toBe('0');});
});
