const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Initialization
  getInitialData: () => ipcRenderer.invoke('get-initial-data'),
  
  // Network interfaces
  getInterfaces: () => ipcRenderer.invoke('get-interfaces'),
  setInterface: (address) => ipcRenderer.send('set-interface', address),
  onInterfaceChanged: (callback) => {
    ipcRenderer.on('interface-changed', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('interface-changed');
  },
  
  // Streams
  onStreamsUpdate: (callback) => {
    ipcRenderer.on('streams-update', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('streams-update');
  },
  addManualStream: (sdp) => ipcRenderer.send('add-manual-stream', sdp),
  removeStream: (streamId) => ipcRenderer.send('remove-stream', streamId),
  
  // Monitoring (levels)
  startMonitoring: (stream) => ipcRenderer.send('start-monitoring', stream),
  stopMonitoring: (streamId) => ipcRenderer.send('stop-monitoring', streamId),
  onAudioLevels: (callback) => {
    ipcRenderer.on('audio-levels', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('audio-levels');
  },
  
  // Audio playback
  playStream: (data) => ipcRenderer.send('play-stream', data),
  stopPlayback: () => ipcRenderer.send('stop-playback'),
  onAudioStatus: (callback) => {
    ipcRenderer.on('audio-status', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('audio-status');
  },
  onAudioError: (callback) => {
    ipcRenderer.on('audio-error', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('audio-error');
  },
  
  // Audio devices
  getAudioDevices: () => ipcRenderer.invoke('get-audio-devices'),
  setAudioDevice: (device) => ipcRenderer.send('set-audio-device', device),
  
  // Settings
  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),

  // Port conflict notifications
  onPortConflict: (callback) => {
    ipcRenderer.on('port-conflict', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('port-conflict');
  },
  onSdpError: (callback) => {
    ipcRenderer.on('sdp-error', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('sdp-error');
  },
  onSdpStatus: (callback) => {
    ipcRenderer.on('sdp-status', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('sdp-status');
  },

  // PTP monitoring
  onPtpStatus: (callback) => {
    ipcRenderer.on('ptp-status', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('ptp-status');
  },

  // Dante device list (pure Dante without AES67)
  onDanteDevices: (callback) => {
    ipcRenderer.on('dante-devices', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('dante-devices');
  },
});
