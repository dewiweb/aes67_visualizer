/**
 * Dante Discovery Child Process
 * Uses mDNS/DNS-SD (Bonjour) to discover Dante devices and channels
 * Based on network-audio-controller approach
 */

const Bonjour = require('bonjour-service').default;
const crypto = require('crypto');

// Dante mDNS service types
const DANTE_SERVICES = [
  '_netaudio-arc._udp',  // Audio Routing Control
  '_netaudio-cmc._udp',  // Clocking/Management Control
  '_netaudio-dbc._udp',  // Device Browser Control
];

let bonjour = null;
let browsers = [];
let devices = new Map(); // hostname -> device info
let channels = new Map(); // device hostname -> channels
let updateTimer = null;

/**
 * Generate stream ID from device info
 */
function generateStreamId(device, channelInfo) {
  const data = `${device.host}-${channelInfo?.name || 'default'}`;
  return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * Parse Dante device from mDNS service
 */
function parseDevice(service) {
  const txt = service.txt || {};
  
  return {
    name: service.name,
    host: service.host,
    addresses: service.addresses || [],
    port: service.port,
    type: service.type,
    // Dante-specific properties from TXT records
    id: txt.id || null,
    model: txt.model || null,
    manufacturer: txt.mf || txt.manufacturer || 'Audinate',
    sampleRate: txt.rate ? parseInt(txt.rate) : 48000,
    latency: txt.latency_ns ? parseInt(txt.latency_ns) : null,
    channels: txt.chans ? parseInt(txt.chans) : null,
    txChannels: txt.txc ? parseInt(txt.txc) : null,
    rxChannels: txt.rxc ? parseInt(txt.rxc) : null,
    isDante: true,
    isAES67: txt.aes67 === '1' || txt.aes67 === 'true',
    software: txt.router_info === '"Dante Via"' ? 'Dante Via' : null,
  };
}

/**
 * Convert Dante device to stream format for UI
 */
function deviceToStream(device) {
  const ipv4 = device.addresses.find(addr => addr.includes('.')) || device.addresses[0];
  
  if (!ipv4) return null;

  // For Dante, we create a "virtual" stream representation
  // Real Dante streams require subscription via Dante protocol
  const txChannels = device.txChannels || device.channels || 2;
  
  return {
    id: generateStreamId(device, null),
    name: device.name,
    mcast: ipv4, // Dante uses unicast, but we store the device IP
    port: device.port || 4440, // Default Dante audio port
    channels: txChannels,
    sampleRate: device.sampleRate || 48000,
    codec: 'L24', // Dante typically uses 24-bit
    ptime: 1,
    sourceType: 'dante',
    isSupported: true,
    dante: true,
    danteDevice: {
      host: device.host,
      model: device.model,
      manufacturer: device.manufacturer,
      isAES67: device.isAES67,
      software: device.software,
    },
    // Note: Pure Dante streams cannot be monitored without subscription
    // This is informational only unless AES67 mode is enabled
    requiresSubscription: !device.isAES67,
  };
}

/**
 * Send update to main process
 */
function sendUpdate() {
  const streams = [];
  
  for (const [hostname, device] of devices) {
    const stream = deviceToStream(device);
    if (stream) {
      streams.push(stream);
    }
  }

  process.send({ type: 'dante-streams', streams });
}

/**
 * Schedule debounced update
 */
function scheduleUpdate() {
  if (updateTimer) {
    clearTimeout(updateTimer);
  }
  updateTimer = setTimeout(sendUpdate, 500);
}

/**
 * Handle service discovery
 */
function onServiceUp(service) {
  console.log(`[Dante] Found: ${service.name} (${service.type})`);
  
  const device = parseDevice(service);
  const existingDevice = devices.get(service.host);
  
  if (existingDevice) {
    // Merge information from multiple service types
    devices.set(service.host, { ...existingDevice, ...device });
  } else {
    devices.set(service.host, device);
  }
  
  scheduleUpdate();
}

/**
 * Handle service removal
 */
function onServiceDown(service) {
  console.log(`[Dante] Lost: ${service.name}`);
  
  if (service.host) {
    devices.delete(service.host);
    scheduleUpdate();
  }
}

/**
 * Initialize mDNS browsing
 */
function init() {
  if (bonjour) {
    stop();
  }

  try {
    bonjour = new Bonjour();
    
    console.log('[Dante] Starting mDNS discovery...');
    
    // Browse for each Dante service type
    for (const serviceType of DANTE_SERVICES) {
      const browser = bonjour.find({ type: serviceType }, onServiceUp);
      
      // Note: bonjour-service doesn't have a direct 'down' event on find
      // Services timeout naturally when they stop announcing
      
      browsers.push(browser);
      console.log(`[Dante] Browsing for ${serviceType}`);
    }

    process.send({ type: 'status', status: 'browsing' });
  } catch (e) {
    console.error('[Dante] Init error:', e.message);
    process.send({ type: 'error', message: e.message });
  }
}

/**
 * Stop mDNS browsing
 */
function stop() {
  for (const browser of browsers) {
    try {
      browser.stop();
    } catch (e) { /* ignore */ }
  }
  browsers = [];
  
  if (bonjour) {
    try {
      bonjour.destroy();
    } catch (e) { /* ignore */ }
    bonjour = null;
  }
  
  devices.clear();
  console.log('[Dante] Stopped');
}

/**
 * Refresh discovery (restart browsing)
 */
function refresh() {
  console.log('[Dante] Refreshing...');
  devices.clear();
  stop();
  init();
}

// IPC message handler
process.on('message', (msg) => {
  switch (msg.type) {
    case 'init':
      init();
      break;
    case 'stop':
      stop();
      break;
    case 'refresh':
      refresh();
      break;
  }
});

process.on('disconnect', () => {
  stop();
  process.exit(0);
});

// Auto-start on load
init();
