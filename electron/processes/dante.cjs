/**
 * Network Audio Discovery Child Process
 * Uses mDNS/DNS-SD (Bonjour) to discover Dante, RAVENNA and AES67 devices
 * Based on network-audio-controller approach
 */

const Bonjour = require('bonjour-service').default;
const crypto = require('crypto');
const net = require('net');
const dgram = require('dgram');

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
 * Fetch SDP from a RAVENNA device via RTSP DESCRIBE (RFC 2326)
 * Returns the raw SDP string or null on failure
 */
function rtspDescribe(ip, port, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buffer = '';
    const cseq = 1;

    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeout);

    socket.connect(port, ip, () => {
      const req = [
        `DESCRIBE rtsp://${ip}:${port}/ RTSP/1.0`,
        `CSeq: ${cseq}`,
        'Accept: application/sdp',
        '',
        '',
      ].join('\r\n');
      socket.write(req);
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      // Wait for end of RTSP response (blank line after headers + body)
      if (buffer.includes('\r\n\r\n')) {
        clearTimeout(timer);
        socket.destroy();

        // Extract SDP body after the double CRLF
        const bodyStart = buffer.indexOf('\r\n\r\n') + 4;
        const sdpBody = buffer.slice(bodyStart).trim();
        resolve(sdpBody.length > 0 ? sdpBody : null);
      }
    });

    socket.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * Query Dante device channel count via ARC protocol (UDP, port from _netaudio-arc._udp)
 * Returns { txChannels, rxChannels } or null
 */
function danteArcQuery(ip, port, timeout = 2000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    // Channel count request: 27ff000affff10000000
    const request = Buffer.from('27ff000affff10000000', 'hex');
    let done = false;

    const timer = setTimeout(() => {
      if (!done) { done = true; socket.close(); resolve(null); }
    }, timeout);

    socket.on('message', (msg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();

      // Response layout (from network-audio-controller reverse engineering):
      // bytes 0-3: header 27ff002c
      // bytes 4-7: ffff1000
      // bytes 8-9: 0001
      // bytes 10-11: TX count (big-endian uint16)
      // bytes 12-13: RX count (big-endian uint16)
      if (msg.length >= 14) {
        const txChannels = msg.readUInt16BE(10);
        const rxChannels = msg.readUInt16BE(12);
        resolve({ txChannels, rxChannels });
      } else {
        resolve(null);
      }
    });

    socket.on('error', () => {
      if (!done) { done = true; clearTimeout(timer); resolve(null); }
    });

    socket.send(request, port, ip, (err) => {
      if (err && !done) { done = true; clearTimeout(timer); socket.close(); resolve(null); }
    });
  });
}

/**
 * Enrich a RAVENNA device with its SDP via RTSP DESCRIBE, then forward as stream
 */
async function fetchRavennaStreams(device) {
  const ip = device.addresses.find(a => a.includes('.'));
  if (!ip || !device.port) return;

  const sdp = await rtspDescribe(ip, device.port);
  if (!sdp) {
    console.log(`[RTSP] No SDP from ${device.name} (${ip}:${device.port})`);
    return;
  }

  console.log(`[RTSP] Got SDP from ${device.name} (${ip}:${device.port})`);
  process.send({ type: 'ravenna-sdp', name: device.name, sdp, sourceIp: ip });
}

/**
 * Enrich a Dante device with its channel count via ARC protocol
 */
async function fetchDanteChannels(device) {
  const ip = device.addresses.find(a => a.includes('.'));
  const arcPort = device.port || 4440;
  if (!ip) return;

  const result = await danteArcQuery(ip, arcPort);
  if (!result) return;

  const existing = devices.get(device.host);
  if (existing) {
    existing.txChannels = result.txChannels || existing.txChannels;
    existing.rxChannels = result.rxChannels || existing.rxChannels;
    devices.set(device.host, existing);
    console.log(`[Dante ARC] ${device.name}: ${result.txChannels}TX / ${result.rxChannels}RX`);
    scheduleUpdate();
  }
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
    devices.set(service.host, { ...existingDevice, ...device });
  } else {
    devices.set(service.host, device);
  }
  
  scheduleUpdate();

  // For RAVENNA devices: fetch SDP via RTSP DESCRIBE
  if (device.isRAVENNA && !existingDevice) {
    fetchRavennaStreams(device);
  }

  // For Dante devices: query channel count via ARC protocol
  if (device.isDante && !existingDevice) {
    fetchDanteChannels(device);
  }
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
