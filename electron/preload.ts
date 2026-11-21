import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, DesktopAPI, LiveNotification } from '../src/shared/types';
let financeCache:import('../src/domain/finance').FinanceState|undefined;
let autoFarmCache:import('../src/shared/auto-farm').AutoFarmState|undefined;
let killCountCache:import('../src/shared/kill-count').KillCountState|undefined;
function mergeState(state:AppState):AppState {
  if(state.expansion?.finance)financeCache=state.expansion.finance;
  if(state.expansion?.autoFarm)autoFarmCache=state.expansion.autoFarm;
  if(state.expansion?.killCount)killCountCache=state.expansion.killCount;
  return state.expansion?{...state,expansion:{...state.expansion,finance:state.expansion.finance??financeCache!,autoFarm:state.expansion.autoFarm??autoFarmCache!,killCount:state.expansion.killCount??killCountCache!}}:state;
}

const api: DesktopAPI = {
  onRareDrop(callback) {
    const listener = (_: Electron.IpcRendererEvent, drop: import('../src/shared/rare-drop').RareDropEvent) => callback(drop);
    ipcRenderer.on('midgard:rare-drop', listener);
    return () => ipcRenderer.removeListener('midgard:rare-drop', listener);
  },
  getTaskbarMode: () => ipcRenderer.invoke('midgard:taskbar-get'),
  compareReplayExperience: mode => ipcRenderer.invoke('midgard:replay-exp-compare',mode),
  setTaskbarMode: active => ipcRenderer.invoke('midgard:taskbar-set',active),
  setKillExperienceRate: async input => mergeState(await ipcRenderer.invoke('midgard:kill-experience-rate',input)),
  setKillExperiencePenalty: async input => mergeState(await ipcRenderer.invoke('midgard:kill-experience-penalty',input)),
  controlKillExperience: async input => mergeState(await ipcRenderer.invoke('midgard:kill-experience-control',input)),
  getSoloExperienceDaily: query => ipcRenderer.invoke('midgard:solo-experience-daily',query),
  getAppearanceTheme: () => ipcRenderer.invoke('midgard:appearance-get'),
  setAppearanceTheme: theme => ipcRenderer.invoke('midgard:appearance-set', theme),
  getFinanceView: () => ipcRenderer.invoke('midgard:finance-view-get'),
  getFinanceDaily: query => ipcRenderer.invoke('midgard:finance-daily', query),
  setFinanceView: view => ipcRenderer.invoke('midgard:finance-view-set', view),
  getKillView: () => ipcRenderer.invoke('midgard:kill-view-get'),
  setKillView: view => ipcRenderer.invoke('midgard:kill-view-set', view),
  getLiveView: () => ipcRenderer.invoke('midgard:live-view-get'),
  setLiveView: view => ipcRenderer.invoke('midgard:live-view-set', view),
  getKillRecords: query => ipcRenderer.invoke('midgard:kill-records', query),
  getKillEvents: query => ipcRenderer.invoke('midgard:kill-events', query),
  getKillDaily: query => ipcRenderer.invoke('midgard:kill-daily', query),
  getHuntAnalytics: query => ipcRenderer.invoke('midgard:hunt-analytics', query),
  getHuntAnalyticsEvidence: query => ipcRenderer.invoke('midgard:hunt-analytics-evidence', query),
  getHuntAnalyticsPreferences: () => ipcRenderer.invoke('midgard:hunt-analytics-preferences-get'),
  setHuntAnalyticsPreferences: value => ipcRenderer.invoke('midgard:hunt-analytics-preferences-set', value),
  getKillRhythm: query => ipcRenderer.invoke('midgard:kill-rhythm', query),
  setReplayClockReference: async input => mergeState(await ipcRenderer.invoke('midgard:replay-clock-set',input)),
  clearReplayClockReference: async streamId => mergeState(await ipcRenderer.invoke('midgard:replay-clock-clear',streamId)),
  setFarmPrice: async input => mergeState(await ipcRenderer.invoke('midgard:farm-price',input)),
  financeCommand: async command => mergeState(await ipcRenderer.invoke('midgard:finance-command',command)),
  searchCatalog: query => ipcRenderer.invoke('midgard:catalog-search',query),
  importCatalog: () => ipcRenderer.invoke('midgard:catalog-import'),
  calibrateExp: input => ipcRenderer.invoke('midgard:exp-calibrate',input),
  setExpJobTrack: (id,jobTrack) => ipcRenderer.invoke('midgard:exp-job-track',id,jobTrack),
  setCharacterAlerts: (key,preferences) => ipcRenderer.invoke('midgard:character-alerts',key,preferences),
  onExpansionNotification(callback) {
    const listener = (_event:Electron.IpcRendererEvent,notification:import('../src/domain/expansion-alerts').ExpansionNotification) => callback(notification);
    ipcRenderer.on('midgard:expansion-notification',listener);
    return () => ipcRenderer.removeListener('midgard:expansion-notification',listener);
  },
  getAlertTargetNames: () => ipcRenderer.invoke('midgard:alert-target-names'),
  setAlertPreferences: patch => ipcRenderer.invoke('midgard:alert-preferences',patch),
  chooseAlertSound: kind => ipcRenderer.invoke('midgard:select-alert-sound',kind),
  chooseRareDropSound: target => ipcRenderer.invoke('midgard:rare-drop-sound-choose',target),
  setRareDropSound: async (target,token) => mergeState(await ipcRenderer.invoke('midgard:rare-drop-sound-set',target,token)),
  getRareDropSound: target => ipcRenderer.invoke('midgard:rare-drop-sound-get',target),
  setSceneDuration: async (kind,seconds) => mergeState(await ipcRenderer.invoke('midgard:scene-duration-set',kind,seconds)),
  chooseRagnarokLevelSound: () => ipcRenderer.invoke('midgard:select-ragnarok-sound'),
  chooseRagnarokMobsterSound: () => ipcRenderer.invoke('midgard:select-mobster-sound'),
  chooseLootChimeSound: () => ipcRenderer.invoke('midgard:select-loot-chime-sound'),
  getAlertSound: kind => ipcRenderer.invoke('midgard:get-alert-sound',kind),
  testAlert: kind => ipcRenderer.invoke('midgard:test-alert',kind),
  onNotification(callback) {
    const listener = (_event: Electron.IpcRendererEvent, notification: LiveNotification) => callback(notification);
    ipcRenderer.on('midgard:notification',listener);
    return () => ipcRenderer.removeListener('midgard:notification',listener);
  },
  getState: async () => mergeState(await ipcRenderer.invoke('midgard:get-state')),
  importFiles: () => ipcRenderer.invoke('midgard:import-files'),
  chooseFolder: () => ipcRenderer.invoke('midgard:choose-folder'),
  scanFolder: () => ipcRenderer.invoke('midgard:scan-folder'),
  reanalyze: id => ipcRenderer.invoke('midgard:reanalyze',id),
  exportData: format => ipcRenderer.invoke('midgard:export',format),
  exportLoot: () => ipcRenderer.invoke('midgard:export-loot'),
  backup: () => ipcRenderer.invoke('midgard:backup'),
  setSettings: patch => ipcRenderer.invoke('midgard:settings',patch),
  addLiveFiles: () => ipcRenderer.invoke('midgard:live-add-files'),
  addLiveFolder: discover => ipcRenderer.invoke('midgard:live-add-folder',discover),
  refreshLive: () => ipcRenderer.invoke('midgard:live-refresh'),
  controlLive: (id,action) => ipcRenderer.invoke('midgard:live-control',id,action),
  assignCharacter: (target,character) => ipcRenderer.invoke('midgard:assign-character',target,character),
  onUpdate(callback) {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState) => { if(state.expansion&&(!state.expansion.finance&&!financeCache||!state.expansion.autoFarm&&!autoFarmCache||!state.expansion.killCount&&!killCountCache))return;callback(mergeState(state)); };
    ipcRenderer.on('midgard:update',listener);
    return () => ipcRenderer.removeListener('midgard:update',listener);
  },
};
contextBridge.exposeInMainWorld('midgard',Object.freeze(api));
