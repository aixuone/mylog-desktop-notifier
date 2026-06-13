// preload.js - Preload script (secure IPC bridge)
// Call & toast windows use this to safely communicate with the main process

const { contextBridge, ipcRenderer } = require('electron')

console.log('[Preload] Loaded')

contextBridge.exposeInMainWorld('electronAPI', {
  // ─── Call window ──────────────────────────────
  /** Send user action (accept/reject/ignore/timeout) for audio/video calls */
  sendCallAction: (action) => ipcRenderer.send('call-action', action),

  /** Receive call data (caller info + ringtone path) */
  onCallData: (callback) => ipcRenderer.on('call-data', (_, data) => callback(data)),

  /** Receive stop ringtone command */
  onStopRingtone: (callback) => ipcRenderer.on('stop-ringtone', () => callback()),

  // ─── Meeting window ───────────────────────────
  /** Send user action (accept/reject/timeout) for meeting invitations */
  sendMeetingAction: (action) => ipcRenderer.send('meeting-action', action),

  /** Receive meeting invite data */
  onMeetingData: (callback) => ipcRenderer.on('meeting-data', (_, data) => callback(data)),

  // ─── Toast window ─────────────────────────────
  /** Close message toast */
  closeToast: () => ipcRenderer.send('close-toast'),

  /** Receive toast data (sender info + message) */
  onToastData: (callback) => ipcRenderer.on('toast-data', (_, data) => callback(data)),

  // ─── Browser ──────────────────────────────────
  /** Open browser to conversation page */
  openBrowser: (url) => ipcRenderer.send('open-browser', url),
})
