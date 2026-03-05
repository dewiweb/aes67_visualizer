import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { fork, exec } from 'child_process';
import Store from 'electron-store';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const store = new Store();

let mainWindow;
let sdpProcess;
let danteProcess;
let audioProcess;
let metersProcess;
let ptpProcess;

// Stream storage
let sapStreams = [];
let danteDevices = [];
let probedIps = new Set(); // IPs already probed via RTSP

// Persistent data
let persistentData = store.get('persistentData', {
  settings: {
    bufferSize: 16,
    bufferEnabled: true,
    hideUnsupported: true,
    sdpDeleteTimeout: 300,
    language: 'en',
  },
});

let currentNetworkInterface = store.get('interface') || null;
let currentAudioDevice = store.get('audioInterface');

/**
 * Find which process is using a specific UDP port
 */
async function findProcessUsingPort(port) {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const command = isWindows
      ? `netstat -ano | findstr ":${port}"`
      : `lsof -i UDP:${port} -t`;

    exec(command, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(null);
        return;
      }

      try {
        if (isWindows) {
          // Parse Windows netstat output: Proto Local Address Foreign Address State PID
          const lines = stdout.trim().split('\n');
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 5) {
              const pid = parts[parts.length - 1];
              if (pid && !isNaN(parseInt(pid))) {
                // Get process name from PID
                exec(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, (err, taskOutput) => {
                  if (err || !taskOutput.trim()) {
                    resolve({ pid, name: 'Unknown' });
                    return;
                  }
                  // Parse CSV: "name.exe","PID","Session Name","Session#","Mem Usage"
                  const match = taskOutput.match(/"([^"]+)"/);
                  const name = match ? match[1] : 'Unknown';
                  resolve({ pid: parseInt(pid), name });
                });
                return;
              }
            }
          }
        } else {
          // Unix: lsof returns PID directly
          const pid = parseInt(stdout.trim().split('\n')[0]);
          exec(`ps -p ${pid} -o comm=`, (err, psOutput) => {
            const name = err ? 'Unknown' : psOutput.trim();
            resolve({ pid, name });
          });
          return;
        }
      } catch (e) {
        console.error('[findProcessUsingPort]', e);
      }
      resolve(null);
    });
  });
}

function getNetworkInterfaces() {
  const interfaces = os.networkInterfaces();
  const result = [];
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        result.push({
          name,
          address: iface.address,
          isCurrent: currentNetworkInterface?.address === iface.address,
        });
      }
    }
  }
  
  return result;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
  });

  const isDev = !app.isPackaged;
  const startUrl = isDev 
    ? 'http://localhost:5173' 
    : `file://${path.join(__dirname, '../dist/index.html')}`;

  mainWindow.loadURL(startUrl);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}



function initChildProcesses() {
  // SDP/SAP Discovery Process
  sdpProcess = fork(path.join(__dirname, 'processes/sdp.cjs'));
  
  sdpProcess.on('message', async (data) => {
    if (data.type === 'streams') {
      sapStreams = data.streams;
      sendToRenderer('streams-update', sapStreams);

      // Probe new SAP source IPs via RTSP to discover all RAVENNA streams
      // Group stream names by IP so probe can try /by-name/<stream> paths
      const ipStreams = {};
      for (const stream of sapStreams) {
        const ip = stream.deviceIp || stream.sapSourceIp;
        if (!ip) continue;
        if (!ipStreams[ip]) ipStreams[ip] = [];
        if (stream.name) ipStreams[ip].push(stream.name);
      }
      for (const [ip, names] of Object.entries(ipStreams)) {
        if (!probedIps.has(ip) && danteProcess) {
          probedIps.add(ip);
          // Try Dante ARC (UDP 4440) to get device name/model/channels
          danteProcess.send({ type: 'probe-arc', ip });
        }
      }
    } else if (data.type === 'port-conflict') {
      console.error('[SDP Port Conflict]', data.message);
      // Try to find which process is using the port
      const blockingProcess = await findProcessUsingPort(data.port);
      sendToRenderer('port-conflict', {
        port: data.port,
        message: data.message,
        blockingProcess
      });
    } else if (data.type === 'status') {
      sendToRenderer('sdp-status', data);
    } else if (data.type === 'error') {
      console.error('[SDP Error]', data.message);
      sendToRenderer('sdp-error', data.message);
    }
  });

  // PTP Monitor Process
  ptpProcess = fork(path.join(__dirname, 'processes/ptp.cjs'));

  ptpProcess.on('message', (data) => {
    if (data.type === 'ptp-clocks') {
      sendToRenderer('ptp-clocks', data.clocks);
    } else if (data.type === 'ptp-status') {
      console.log('[PTP]', data.status, data.interface || '');
    }
  });

  // Audio Playback Process
  audioProcess = fork(path.join(__dirname, 'processes/audio.cjs'));
  
  audioProcess.on('message', (data) => {
    if (data.type === 'status') {
      sendToRenderer('audio-status', data);
    } else if (data.type === 'error') {
      sendToRenderer('audio-error', data.message);
    }
  });

  // Meters Process (level monitoring)
  metersProcess = fork(path.join(__dirname, 'processes/meters.cjs'));
  
  metersProcess.on('message', async (data) => {
    if (data.type === 'levels') {
      sendToRenderer('audio-levels', data.levels);
    } else if (data.type === 'port-conflict') {
      console.error('[Meters Port Conflict]', data.message);
      const blockingProcess = await findProcessUsingPort(data.port);
      sendToRenderer('port-conflict', {
        port: data.port,
        message: data.message,
        blockingProcess,
        source: 'meters',
        stream: data.stream
      });
    }
  });

  // Network Audio Discovery Process (mDNS + ARC + RTSP)
  danteProcess = fork(path.join(__dirname, 'processes/discovery.cjs'));
  
  danteProcess.on('message', (data) => {
    if (data.type === 'dante-devices') {
      danteDevices = data.devices;
      sendToRenderer('dante-devices', danteDevices);
    } else if (data.type === 'ravenna-sdp') {
      // RTSP DESCRIBE returned a SDP — inject into SDP process
      console.log(`[Main] RAVENNA SDP received from ${data.name}, forwarding to SDP process`);
      if (sdpProcess) {
        sdpProcess.send({ type: 'add-stream', sdp: data.sdp, sourceIp: data.sourceIp });
      }
    } else if (data.type === 'status') {
      console.log('[Dante]', data.status);
    } else if (data.type === 'error') {
      console.error('[Dante Error]', data.message);
    }
  });
}

function setupIpcHandlers() {
  // Get initial data
  ipcMain.handle('get-initial-data', () => {
    return {
      interfaces: getNetworkInterfaces(),
      persistentData,
      currentInterface: currentNetworkInterface,
    };
  });

  // Network interface management
  ipcMain.handle('get-interfaces', () => getNetworkInterfaces());
  
  ipcMain.on('set-interface', (event, address) => {
    const interfaces = getNetworkInterfaces();
    const iface = interfaces.find(i => i.address === address);
    
    if (iface) {
      currentNetworkInterface = iface;
      store.set('interface', iface);
      
      // Reinitialize SDP with new interface (full restart)
      if (sdpProcess) {
        sdpProcess.send({ type: 'init', address });
      }
      if (metersProcess) {
        metersProcess.send({ type: 'set-interface', address });
      }
      if (ptpProcess) {
        ptpProcess.send({ type: 'start', interface: address });
      }
      
      sendToRenderer('interface-changed', iface);
    }
  });

  // Stream monitoring (meters + PTP)
  ipcMain.on('start-monitoring', (event, stream) => {
    if (metersProcess) {
      metersProcess.send({ type: 'start', stream });
    }
    // PTP monitoring is now network-wide (ports 319/320), not per-stream
  });

  ipcMain.on('stop-monitoring', (event, streamId) => {
    if (metersProcess) {
      metersProcess.send({ type: 'stop', streamId });
    }
    // PTP monitoring is network-wide, no per-stream stop needed
  });

  // Audio playback
  ipcMain.on('play-stream', (event, data) => {
    if (audioProcess) {
      audioProcess.send({ 
        type: 'play', 
        ...data,
        audioDevice: currentAudioDevice,
        networkInterface: currentNetworkInterface?.address,
      });
    }
  });

  ipcMain.on('stop-playback', () => {
    if (audioProcess) {
      audioProcess.send({ type: 'stop' });
    }
  });

  // Manual SDP stream
  ipcMain.on('add-manual-stream', (event, sdpText) => {
    if (sdpProcess) {
      sdpProcess.send({ type: 'add-manual', sdp: sdpText });
    }
  });

  ipcMain.on('remove-stream', (event, streamId) => {
    if (sdpProcess) {
      sdpProcess.send({ type: 'remove', streamId });
    }
  });

  // Settings
  ipcMain.on('save-settings', (event, settings) => {
    persistentData.settings = { ...persistentData.settings, ...settings };
    store.set('persistentData', persistentData);
    
    if (sdpProcess && settings.sdpDeleteTimeout !== undefined) {
      sdpProcess.send({ type: 'set-timeout', timeout: settings.sdpDeleteTimeout });
    }
  });

  // Audio device
  ipcMain.handle('get-audio-devices', async () => {
    return new Promise((resolve) => {
      if (audioProcess) {
        const handler = (data) => {
          if (data.type === 'devices') {
            audioProcess.off('message', handler);
            resolve(data.devices);
          }
        };
        audioProcess.on('message', handler);
        audioProcess.send({ type: 'get-devices' });
      } else {
        resolve([]);
      }
    });
  });

  ipcMain.on('set-audio-device', (event, device) => {
    currentAudioDevice = device;
    store.set('audioInterface', device);
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  initChildProcesses();
  setupIpcHandlers();

  // Auto-select first interface if none saved
  if (!currentNetworkInterface) {
    const ifaces = getNetworkInterfaces();
    if (ifaces.length > 0) {
      currentNetworkInterface = ifaces[0];
      store.set('interface', currentNetworkInterface);
      console.log(`[Main] Auto-selected interface: ${currentNetworkInterface.address}`);
    }
  }

  // Initialize SDP, Meters and PTP processes with current interface
  if (currentNetworkInterface) {
    if (sdpProcess) {
      sdpProcess.send({ type: 'init', address: currentNetworkInterface.address });
    }
    if (metersProcess) {
      metersProcess.send({ type: 'set-interface', address: currentNetworkInterface.address });
    }
    if (ptpProcess) {
      ptpProcess.send({ type: 'start', interface: currentNetworkInterface.address });
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Cleanup child processes
  if (sdpProcess) sdpProcess.kill();
  if (danteProcess) danteProcess.kill();
  if (audioProcess) audioProcess.kill();
  if (metersProcess) metersProcess.kill();
  if (ptpProcess) ptpProcess.kill();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (sdpProcess) sdpProcess.kill();
  if (danteProcess) danteProcess.kill();
  if (audioProcess) audioProcess.kill();
  if (metersProcess) metersProcess.kill();
  if (ptpProcess) ptpProcess.kill();
});
