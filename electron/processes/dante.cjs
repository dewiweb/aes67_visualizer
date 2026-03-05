/**
 * Network Audio Discovery Child Process
 * Uses dns-sd.exe (Apple Bonjour native) to discover Dante, RAVENNA and AES67 devices
 * Falls back to bonjour-service npm if dns-sd.exe is not available
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const dgram = require('dgram');

// All mDNS service types to browse — full DNS-SD format
const ALL_SERVICES = [
  { type: '_netaudio-arc._udp',     family: 'dante'   },
  { type: '_netaudio-cmc._udp',     family: 'dante'   },
  { type: '_netaudio-dbc._udp',     family: 'dante'   },
  { type: '_ravenna._tcp',          family: 'ravenna'  },
  { type: '_ravenna-session._tcp',  family: 'ravenna'  },
  { type: '_aes67._udp',            family: 'aes67'    },
];

let dnsSdProcs = [];
let resolveProcs = [];
let devices = new Map(); // hostname -> device info
let updateTimer = null;

/**
 * Detect protocol family from full service type string
 */
function getProtocolFamily(fullType) {
  const svc = ALL_SERVICES.find(s => fullType.startsWith(s.type.split('.')[0].replace('_', '')));
  if (!svc) {
    if (fullType.includes('netaudio')) return 'dante';
    if (fullType.includes('ravenna'))  return 'ravenna';
    if (fullType.includes('aes67'))    return 'aes67';
  }
  return svc ? svc.family : 'unknown';
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
 * Parse dns-sd.exe -B browse output line
 * Format: "Add  <flags> <if> <domain> <type>       <instance>"
 */
function parseBrowseLine(line, serviceType, family) {
  // dns-sd -B output: Add  2  5 local. _netaudio-arc._udp. Device\ Name
  const match = line.match(/^Add\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+(.+)$/);
  if (!match) return;

  const domain  = match[1].replace(/\.$/, '');
  const type    = match[2].replace(/\.$/, '');
  const name    = match[3].trim().replace(/\\ /g, ' ');

  // Trigger a resolve to get host + port + txt
  resolveService(name, serviceType, family);
}

/**
 * Resolve a service instance via dns-sd.exe -L
 * Extracts host, port, txt records
 */
function resolveService(name, serviceType, family) {
  const proc = spawn('dns-sd', ['-L', name, serviceType, 'local'], { windowsHide: true });
  resolveProcs.push(proc);

  let buffer = '';
  const timer = setTimeout(() => proc.kill(), 5000);

  proc.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      // Line format: "  instance can be reached at host.local.:port (interface N)"
      // TXT records: "  key=value key2=value2 ..."
      const reachMatch = line.match(/can be reached at ([\w.-]+):?(\d+)/i);
      if (reachMatch) {
        const host = reachMatch[1];
        const port = parseInt(reachMatch[2]) || 0;

        // Extract TXT records from same line
        const txtRaw = line.replace(/.*can be reached at.*?(?=\s+[a-z]+=|$)/i, '').trim();
        const txt = {};
        for (const kv of txtRaw.split(/\s+/)) {
          const eq = kv.indexOf('=');
          if (eq > 0) txt[kv.slice(0, eq)] = kv.slice(eq + 1);
        }

        // Resolve host to IP via dns-sd -G
        resolveHostToIP(host, (ip) => {
          onServiceUp({
            name,
            type: serviceType.split('.')[0].replace('_', ''),
            host,
            addresses: ip ? [ip] : [],
            port,
            txt,
            family,
          });
        });

        clearTimeout(timer);
        proc.kill();
      }
    }
  });

  proc.on('close', () => {
    clearTimeout(timer);
    const idx = resolveProcs.indexOf(proc);
    if (idx >= 0) resolveProcs.splice(idx, 1);
  });

  proc.stderr.on('data', () => {});
}

/**
 * Resolve a .local hostname to IPv4 via dns-sd -G v4
 */
function resolveHostToIP(host, callback) {
  const proc = spawn('dns-sd', ['-G', 'v4', host], { windowsHide: true });
  let resolved = false;
  const timer = setTimeout(() => { if (!resolved) { resolved = true; proc.kill(); callback(null); } }, 3000);

  proc.stdout.on('data', (data) => {
    if (resolved) return;
    const text = data.toString();
    // Line: "Timestamp    Host         Flags  IF  Address       TTL"
    //        "9:00:00.000  host.local.  2      5   192.168.1.10  120"
    const match = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    if (match) {
      resolved = true;
      clearTimeout(timer);
      proc.kill();
      callback(match[1]);
    }
  });

  proc.on('close', () => { if (!resolved) { resolved = true; callback(null); } });
  proc.stderr.on('data', () => {});
}

/**
 * Initialize mDNS browsing using dns-sd.exe (Apple Bonjour native)
 */
function init() {
  stop();

  console.log('[Discovery] Starting mDNS discovery via dns-sd.exe (Dante + RAVENNA + AES67)...');

  for (const svc of ALL_SERVICES) {
    console.log(`[Discovery] Browsing for ${svc.type}`);

    const proc = spawn('dns-sd', ['-B', svc.type, 'local'], { windowsHide: true });
    dnsSdProcs.push(proc);

    let buffer = '';
    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('Add')) {
          parseBrowseLine(line, svc.type, svc.family);
        } else if (line.startsWith('Rmv')) {
          // Service removed — extract name and remove from map
          const match = line.match(/^Rmv\s+\d+\s+\d+\s+\S+\s+\S+\s+(.+)$/);
          if (match) onServiceDown({ name: match[1].trim(), host: match[1].trim() });
        }
      }
    });

    proc.stderr.on('data', () => {});
    proc.on('close', (code) => {
      const idx = dnsSdProcs.indexOf(proc);
      if (idx >= 0) dnsSdProcs.splice(idx, 1);
      if (code !== null && code !== 0) {
        console.error(`[Discovery] dns-sd exited with code ${code} for ${svc.type}`);
      }
    });
  }

  process.send({ type: 'status', status: 'browsing' });
}

/**
 * Stop all dns-sd processes
 */
function stop() {
  for (const proc of [...dnsSdProcs, ...resolveProcs]) {
    try { proc.kill(); } catch (e) { /* ignore */ }
  }
  dnsSdProcs = [];
  resolveProcs = [];
  devices.clear();
  console.log('[Dante] Stopped');
}

/**
 * Refresh discovery (restart browsing)
 */
function refresh() {
  console.log('[Dante] Refreshing...');
  stop();
  init();
}

/**
 * Probe RTSP on an IP across common RAVENNA ports, forward any SDP found
 */
async function probeRtspIp(ip) {
  const RAVENNA_RTSP_PORTS = [9010, 554, 8554, 9020, 8000, 5000, 7272];
  for (const port of RAVENNA_RTSP_PORTS) {
    const sdp = await rtspDescribe(ip, port, 2000);
    if (sdp) {
      console.log(`[RTSP Probe] ${ip}:${port} → SDP found`);
      process.send({ type: 'ravenna-sdp', name: ip, sdp, sourceIp: ip });
      return; // found on this port, stop probing
    }
  }
  console.log(`[RTSP Probe] ${ip}: no RTSP response on any port`);
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
    case 'probe-rtsp':
      probeRtspIp(msg.ip);
      break;
  }
});

process.on('disconnect', () => {
  stop();
  process.exit(0);
});

// Auto-start on load
init();
