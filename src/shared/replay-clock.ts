import type {LiveStreamStatus} from './types';

export type ReplayClockReferenceStatus='none'|'running'|'paused';
export interface ReplayClockReferenceInput {streamId:string;recordingId:string;elapsedText:string;}
export interface ReplayClockObservation {streamId:string;recordingId:string;replayElapsedMs:number;observedAt?:number|string;reset?:boolean;}
export interface ReplayClockView {
  streamId:string;recordingId:string;replayElapsedMs:number;
  referenceElapsedMs:number|null;offsetMs:number|null;referenceStatus:ReplayClockReferenceStatus;
  referenceSetAtISO:string|null;lastReplayAdvanceAtISO:string|null;
  streamStatus:LiveStreamStatus;revision:number;
}
export interface ReplayClockState {revision:number;streams:ReplayClockView[];}
