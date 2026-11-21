import {assistanceReplay,baselinePackets,status} from './assistance-fixtures.mjs';
export {assistanceReplay,baselinePackets,status};
export function monsterSpawn(aid,monsterId=1002,name='Hode',kind=5){const encoded=Buffer.from(`${name}\0`,'utf8'),packet=Buffer.alloc(69+encoded.length);packet.writeUInt16LE(0x0857);packet.writeUInt16LE(packet.length,2);packet[4]=kind;packet.writeUInt32LE(aid,5);packet.writeInt16LE(monsterId,19);encoded.copy(packet,69);return packet;}
export function vanish(aid,mode=1){const packet=Buffer.alloc(7);packet.writeUInt16LE(0x0080);packet.writeUInt32LE(aid,2);packet[6]=mode;return packet;}
export function damage(source,target){const packet=Buffer.alloc(33);packet.writeUInt16LE(0x02e1);packet.writeUInt32LE(source,2);packet.writeUInt32LE(target,6);packet.writeInt32LE(100,22);packet.writeInt16LE(1,26);return packet;}
export function mobDeath(aid,monsterId=1002,name='Hode',player=42){return[monsterSpawn(aid,monsterId,name),damage(player,aid),vanish(aid)];}
export function incompleteDeathReplay({character,player,packets}){const partial=[...packets.slice(0,-1),packets.at(-1).subarray(0,5)],file=assistanceReplay({character,player,packets:partial});const lastHeader=352+partial.slice(0,-1).reduce((sum,packet)=>sum+10+packet.length,0);file.writeUInt16LE(7,lastHeader+8);return file;}
