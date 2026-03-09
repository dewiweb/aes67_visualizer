const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Initialization
  getInitialData: () => ipcRenderer.invoke('get-initial-data'),
  
  // Network interfaces
  getInterfaces: () => ipcRenderer.invoke('get-interfaces'),
  setInterface: (address) => ipcRenderer.send('set-interface', address),
  onInterfaceChanged: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('interface-changed', handler);
    return () => ipcRenderer.removeListener('interface-changed', handler);
  },
  
  // Streams
  onStreamsUpdate: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('streams-update', handler);
    return () => ipcRenderer.removeListener('streams-update', handler);
  },
  addManualStream: (sdp) => ipcRenderer.send('add-manual-stream', sdp),
  removeStream: (streamId) => ipcRenderer.send('remove-stream', streamId),
  
  // Monitoring (levels)
  startMonitoring: (stream) => ipcRenderer.send('start-monitoring', stream),
  stopMonitoring: (streamId) => ipcRenderer.send('stop-monitoring', streamId),
  onAudioLevels: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('audio-levels', handler);
    return () => ipcRenderer.removeListener('audio-levels', handler);
  },
  
  // Audio playback
  playStream: (data) => ipcRenderer.send('play-stream', data),
  stopPlayback: () => ipcRenderer.send('stop-playback'),
  onAudioStatus: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('audio-status', handler);
    return () => ipcRenderer.removeListener('audio-status', handler);
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
    const handler = (_, data) => callback(data);
    ipcRenderer.on('port-conflict', handler);
    return () => ipcRenderer.removeListener('port-conflict', handler);
  },
  onSdpError: (callback) => {
    ipcRenderer.on('sdp-error', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('sdp-error');
  },
  onSdpStatus: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('sdp-status', handler);
    return () => ipcRenderer.removeListener('sdp-status', handler);
  },

  // PTP monitoring (network-wide, IEEE 1588 ports 319/320)
  onPtpClocks: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('ptp-clocks', handler);
    return () => ipcRenderer.removeListener('ptp-clocks', handler);
  },

  // Network device list (Dante, RAVENNA, AES67)
  onNetworkDevices: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('network-devices', handler);
    return () => ipcRenderer.removeListener('network-devices', handler);
  },

  // Dante ARC write commands
  arcSetDeviceName: (ip, port, name) => ipcRenderer.invoke('arc-set-device-name', { ip, port, name }),
  arcSetSubscription: (ip, port, rxChannelId, txChannelName, txDeviceName) =>
    ipcRenderer.invoke('arc-set-subscription', { ip, port, rxChannelId, txChannelName, txDeviceName }),
  arcUnsubscribeRx: (ip, port, rxChannelId) =>
    ipcRenderer.invoke('arc-unsubscribe-rx', { ip, port, rxChannelId }),

  // mDNS system errors (avahi-browse missing / daemon not running)
  onMdnsError: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('mdns-error', handler);
    return () => ipcRenderer.removeListener('mdns-error', handler);
  },
});
