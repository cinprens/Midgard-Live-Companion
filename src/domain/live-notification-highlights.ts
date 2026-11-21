import type {LiveNotification} from './notifications';

export const LIVE_NOTIFICATION_HIGHLIGHT_MS=5000;
export interface LiveNotificationHighlight {id:string;atMs:number;expiresAt:number;}
export interface LiveNotificationHighlights {card:LiveNotificationHighlight|null;items:Map<number,LiveNotificationHighlight>;}
const itemKinds=new Set<LiveNotification['type']>(['card','glass-bead','old-blue-box']);

/** Only a recent, source-matched notification can animate an existing value. */
export function liveNotificationHighlights(notifications:readonly LiveNotification[],streamIds:readonly string[],now:number):LiveNotificationHighlights {
  const result:LiveNotificationHighlights={card:null,items:new Map()};
  if(!Number.isFinite(now)||!streamIds.length)return result;
  const sources=new Set(streamIds);
  for(const notification of notifications){
    if(!sources.has(notification.streamId)||typeof notification.id!=='string'||!notification.id)continue;
    const atMs=Date.parse(notification.at),elapsed=now-atMs;
    if(!Number.isFinite(atMs)||elapsed<0||elapsed>=LIVE_NOTIFICATION_HIGHLIGHT_MS)continue;
    const highlight={id:notification.id,atMs,expiresAt:atMs+LIVE_NOTIFICATION_HIGHLIGHT_MS};
    if(!result.card||atMs>result.card.atMs)result.card=highlight;
    const itemId=notification.itemId;
    if(!itemKinds.has(notification.type)||typeof itemId!=='number'||!Number.isSafeInteger(itemId)||itemId<=0||itemId>0xffffffff)continue;
    const previous=result.items.get(itemId);
    if(!previous||atMs>previous.atMs)result.items.set(itemId,highlight);
  }
  return result;
}
