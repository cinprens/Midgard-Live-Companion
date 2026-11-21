import {assistanceReplay,baselinePackets,cardReceived,status,verifiedItemReceipt} from './assistance-fixtures.mjs';
export {assistanceReplay,cardReceived,status,verifiedItemReceipt};
export function bagBaseline(){
  const start=Buffer.alloc(5);start.writeUInt16LE(0x0b08);start.writeUInt16LE(5,2);
  const list=Buffer.alloc(39);list.writeUInt16LE(0x0b09);list.writeUInt16LE(list.length,2);list.writeUInt16LE(7,5);list.writeUInt32LE(501,7);list.writeUInt16LE(20,12);
  const end=Buffer.alloc(4);end.writeUInt16LE(0x0b0b);
  return[...baselinePackets(),start,list,end,status(24,60000)];
}
export function groundOnly(amount=999){const out=Buffer.alloc(24);out.writeUInt16LE(0x0add);out.writeUInt32LE(701,2);out.writeUInt32LE(501,6);out[12]=1;out.writeInt16LE(120,13);out.writeInt16LE(150,15);out.writeInt16LE(amount,19);return out;}
export function removeFromBag(amount=5){const out=Buffer.alloc(6);out.writeUInt16LE(0x00af);out.writeUInt16LE(7,2);out.writeUInt16LE(amount,4);return out;}
export function tradeReceipt(amount=50){const accept=Buffer.alloc(3);accept.writeUInt16LE(0x00e7);accept[2]=3;const finish=Buffer.alloc(2);finish.writeUInt16LE(0x00ee);return[accept,cardReceived(501,amount),finish,status(5,10000)];}
