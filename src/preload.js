'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('afv', {
  init: () => ipcRenderer.invoke('app:init'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  setFleet: (f) => ipcRenderer.invoke('fleet:set', f),
  loadSimbrief: () => ipcRenderer.invoke('simbrief:load'),
  demoPlan: () => ipcRenderer.invoke('demo:plan'),
  startFlight: (o) => ipcRenderer.invoke('flight:start', o),
  stopFlight: () => ipcRenderer.invoke('flight:stop'),
  pickSound: (key) => ipcRenderer.invoke('sound:pick', key),
  resetSound: (key) => ipcRenderer.invoke('sound:reset', key),
  saveFeedback: (f) => ipcRenderer.invoke('feedback:save', f),
  listReports: () => ipcRenderer.invoke('reports:list'),
  openFolder: (w) => ipcRenderer.invoke('folder:open', w),
  getUpdate: () => ipcRenderer.invoke('update:get'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getChangelog: () => ipcRenderer.invoke('changelog:get'),
  changelogSeen: () => ipcRenderer.invoke('changelog:seen'),
  voiceStatus: () => ipcRenderer.invoke('voice:status'),
  voiceDownload: () => ipcRenderer.invoke('voice:download'),
  voiceRemove: () => ipcRenderer.invoke('voice:remove'),
  voiceSpeak: (text, force) => ipcRenderer.invoke('voice:speak', text, !!force),
  voicePreload: () => ipcRenderer.invoke('voice:preload'),
  getCareer: () => ipcRenderer.invoke('career:get'),
  acceptMission: (id) => ipcRenderer.invoke('career:accept', id),
  dropMission: (id) => ipcRenderer.invoke('career:drop', id),
  setActiveMission: (id) => ipcRenderer.invoke('career:active', id),
  getInfos: () => ipcRenderer.invoke('infos:get'),
  getMetar: (ids) => ipcRenderer.invoke('metar:get', ids),
  fileUrl: (p) => pathToFileURL(p).href,
  on: (ch, fn) => {
    const ok = ['sim:status', 'flight:tick', 'flight:event', 'flight:report', 'fleet:changed', 'update:status', 'voice:status', 'career:changed', 'infos:changed'];
    if (ok.includes(ch)) ipcRenderer.on(ch, (_e, d) => fn(d));
  }
});
