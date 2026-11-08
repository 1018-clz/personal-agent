import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import { IPC, type AppEvent, type DesktopApi } from "../shared/types";

const api: DesktopApi = {
  sendPrompt: (text) => ipcRenderer.invoke(IPC.sendPrompt, text),
  cancelTurn: () => ipcRenderer.invoke(IPC.cancelTurn),
  newSession: () => ipcRenderer.invoke(IPC.newSession),
  openSession: (sessionId) => ipcRenderer.invoke(IPC.openSession, sessionId),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC.deleteSession, sessionId),
  answerPermission: (answer) => ipcRenderer.invoke(IPC.answerPermission, answer),
  getModelSettings: () => ipcRenderer.invoke(IPC.getModelSettings),
  saveModelSettings: (input) => ipcRenderer.invoke(IPC.saveModelSettings, input),
  testModelSettings: (input) => ipcRenderer.invoke(IPC.testModelSettings, input),
  listModels: (input) => ipcRenderer.invoke(IPC.listModels, input),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  cancelHfssJob: (jobId) => ipcRenderer.invoke(IPC.cancelHfssJob, jobId),
  getHfssCurves: (jobId) => ipcRenderer.invoke(IPC.getHfssCurves, jobId),
  setAutoAnalyze: (on) => ipcRenderer.invoke(IPC.setAutoAnalyze, on),
  checkSetup: () => ipcRenderer.invoke(IPC.checkSetup),
  install: (target) => ipcRenderer.invoke(IPC.install, target),
  onEvent: (listener) => {
    const forward = (_event: IpcRendererEvent, event: AppEvent) => listener(event);
    ipcRenderer.on(IPC.event, forward);
    // Ready is sent only now, so nothing is emitted before someone is listening.
    ipcRenderer.send(IPC.rendererReady);
    return () => ipcRenderer.removeListener(IPC.event, forward);
  },
};

contextBridge.exposeInMainWorld("desktop", api);
