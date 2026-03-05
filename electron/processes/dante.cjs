/**
 * Network Audio Discovery Child Process
 * Uses mDNS/DNS-SD (Bonjour) to discover Dante, RAVENNA and AES67 devices
 * Based on network-audio-controller approach
 */

const Bonjour = require('bonjour-service').default;
const crypto = require('crypto');

// Dante mDNS service types — type/protocol separated (bonjour-service adds _ prefix itself)
const DANTE_SERVICES = [
  { type: 'netaudio-arc', protocol: 'udp' },  // Audio Routing Control
  { type: 'netaudio-cmc', protocol: 'udp' },  // Clocking/Management Control
  { type: 'netaudio-dbc', protocol: 'udp' },  // Device Browser Control
];

// RAVENNA / AES67 mDNS service types
const RAVENNA_SERVICES = [
  { type: 'ravenna',          protocol: 'tcp' },  // RAVENNA device discovery
  { type: 'ravenna-session',  protocol: 'tcp' },  // RAVENNA session announcement
];

const AES67_SERVICES = [
  { type: 'aes67', protocol: 'udp' },  // AES67 device discovery
];

// For family detection, service.type returned by bonjour-service is the name without _ or protocol
const DANTE_TYPE_NAMES  = DANTE_SERVICES.map(s => s.type);
const RAVENNA_TYPE_NAMES = RAVENNA_SERVICES.map(s => s.type);
const AES67_TYPE_NAMES  = AES67_SERVICES.map(s => s.type);

let bonjour = null;
let browsers = [];
let devices = new Map(); // hostname -> device info
let updateTimer = null;

/**
 * Detect protocol family from service type name (as returned by bonjour-service, no underscores)
 */
function getProtocolFamily(serviceType) {
  if (DANTE_TYPE_NAMES.includes(serviceType))   return 'dante';
  if (RAVENNA_TYPE_NAMES.includes(serviceType)) return 'ravenna';
  if (AES67_TYPE_NAMES.includes(serviceType))   return 'aes67';
  return 'unknown';
}

/**
 * Parse Dante device from mDNS service
 */
function parseDevice(service) {
  const txt = service.txt || {};
  const family = getProtocolFamily(service.type);

  const base = {
    name: service.name,
    host: service.host,
    addresses: service.addresses || [],
    port: service.port,
    type: service.type,
    protocolFamily: family,
  };

  if (family === 'dante') {
    return {
      ...base,
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

  if (family === 'ravenna' || family === 'aes67') {
    // RAVENNA/AES67 TXT records: ver, src, snk, ch, sr, fmt, ptp
    return {
      ...base,
      id: txt.id || null,
      model: txt.model || txt.dname || null,
      manufacturer: txt.mf || txt.manufacturer || null,
      sampleRate: txt.sr ? parseInt(txt.sr) : 48000,
      channels: txt.ch ? parseInt(txt.ch) : null,
      txChannels: txt.src ? parseInt(txt.src) : null,
      rxChannels: txt.snk ? parseInt(txt.snk) : null,
      ptpGrandmaster: txt.ptp || null,
      isDante: false,
      isAES67: true,
      isRAVENNA: family === 'ravenna',
      software: txt.ver || null,
    };
  }

  return base;
}

/**
 * Send update to main process — devices only, streams come from SAP
 */
function sendUpdate() {
  const danteDevices = [];
  
  for (const [hostname, device] of devices) {
    danteDevices.push({
      host: device.host,
      name: device.name,
      addresses: device.addresses || [],
      port: device.port,
      protocolFamily: device.protocolFamily || 'dante',
      manufacturer: device.manufacturer || (device.isDante ? 'Audinate' : null),
      model: device.model || null,
      sampleRate: device.sampleRate || 48000,
      txChannels: device.txChannels || null,
      rxChannels: device.rxChannels || null,
      isDante: device.isDante !== false,
      isAES67: device.isAES67 || false,
      isRAVENNA: device.isRAVENNA || false,
      software: device.software || null,
      requiresAES67: !device.isAES67 && (device.protocolFamily === 'dante'),
    });
  }

  process.send({ type: 'dante-devices', devices: danteDevices });
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
 * Initialize mDNS browsing for Dante, RAVENNA and AES67
 */
function init() {
  if (bonjour) {
    stop();
  }

  try {
    bonjour = new Bonjour();
    
    console.log('[Discovery] Starting mDNS discovery (Dante + RAVENNA + AES67)...');
    
    const allServices = [...DANTE_SERVICES, ...RAVENNA_SERVICES, ...AES67_SERVICES];

    for (const svc of allServices) {
      const browser = bonjour.find({ type: svc.type, protocol: svc.protocol }, onServiceUp);
      browsers.push(browser);
      console.log(`[Discovery] Browsing for _${svc.type}._${svc.protocol}`);
    }

    process.send({ type: 'status', status: 'browsing' });
  } catch (e) {
    console.error('[Discovery] Init error:', e.message);
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
