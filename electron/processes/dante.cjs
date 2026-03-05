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
 * Send one RTSP request and collect the full response (headers + body)
 */
function rtspRequest(socket, method, url, cseq, extraHeaders = '') {
  return new Promise((resolve) => {
    let buffer = '';
    const onData = (data) => {
      buffer += data.toString();
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const headers = buffer.slice(0, headerEnd);
      const body    = buffer.slice(headerEnd + 4);
      const clMatch = headers.match(/Content-Length:\s*(\d+)/i);
      const contentLength = clMatch ? parseInt(clMatch[1]) : 0;

      if (contentLength === 0 || Buffer.byteLength(body) >= contentLength) {
        socket.removeListener('data', onData);
        resolve({ headers, body: body.slice(0, contentLength || body.length) });
      }
    };
    socket.on('data', onData);
    socket.write(
      `${method} ${url} RTSP/1.0\r\nCSeq: ${cseq}\r\nUser-Agent: AES67-Visualizer\r\n${extraHeaders}\r\n`
    );
  });
}

/**
 * Full RTSP DESCRIBE sequence: OPTIONS → DESCRIBE (with common RAVENNA paths)
 * streamNames: known SAP stream names on this device, used for /by-name/ URLs
 * Returns raw SDP string or null
 */
function rtspDescribe(ip, port, streamNames = [], timeout = 4000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => done(null), timeout);

    socket.connect(port, ip, async () => {
      try {
        // RFC 2326: URL should omit port if it's the default (554)
        // Some devices (Lawo) reject URLs with explicit port number
        const baseWithPort    = `rtsp://${ip}:${port}`;
        const baseWithoutPort = port === 554 ? `rtsp://${ip}` : baseWithPort;

        // Step 1: OPTIONS — try without port first (Lawo), then with port
        let optResp = null;
        let base = baseWithoutPort;

        // Try OPTIONS * first (RFC 2326 §10.1 - server-wide), then with URL
        const optionsCandidates = [
          ['*', baseWithoutPort],
          [`${baseWithoutPort}/`, baseWithoutPort],
          [`${baseWithPort}/`,    baseWithPort],
        ];

        for (const [optUrl, tryBase] of optionsCandidates) {
          base = tryBase;
          optResp = await Promise.race([
            rtspRequest(socket, 'OPTIONS', optUrl, 1),
            new Promise(r => setTimeout(() => r(null), 2000)),
          ]);
          if (!optResp) continue;
          const st = optResp.headers.match(/^RTSP\/1\.0\s+(\d+)/);
          console.log(`[RTSP] ${ip}:${port} OPTIONS ${optUrl} → ${st ? st[1] : '?'}`);
          if (st && st[1] === '200') break;
          optResp = null;
        }

        if (!optResp) return done(null);

        const statusMatch = optResp.headers.match(/^RTSP\/1\.0\s+(\d+)/);
        if (!statusMatch || statusMatch[1] !== '200') {
          console.log(`[RTSP] ${ip}:${port} OPTIONS all failed`);
          return done(null);
        }

        // Step 2: DESCRIBE — RAVENNA standard paths + common fallbacks
        // Prepend /by-name/<stream> for each known SAP stream name on this device
        const byNamePaths = streamNames.map(n => `/by-name/${encodeURIComponent(n)}`);
        const byIdPaths   = Array.from({ length: Math.max(streamNames.length, 4) }, (_, i) => `/by-id/${i + 1}`);
        const paths = [
          ...byNamePaths,   // RAVENNA /by-name/<stream> — most specific, try first
          '/',
          '/by-name/',      // RAVENNA: list all streams (some devices support this)
          ...byIdPaths,     // RAVENNA /by-id/1, /by-id/2, ...
          '/stream',
          '/streams',
          '/audio',
          '/ravenna',
          '/session',
        ];

        let cseq = 2;
        for (const path of paths) {
          const desc = await Promise.race([
            rtspRequest(socket, 'DESCRIBE', `${base}${path}`, cseq++, 'Accept: application/sdp\r\n'),
            new Promise(r => setTimeout(() => r(null), 2000)),
          ]);

          if (!desc) continue;

          const dStatus = desc.headers.match(/^RTSP\/1\.0\s+(\d+)/);
          if (dStatus && dStatus[1] === '200' && desc.body.trim().startsWith('v=')) {
            return done(desc.body.trim());
          }
          if (dStatus && !['404','400'].includes(dStatus[1])) {
            console.log(`[RTSP] ${ip}:${port}${path} DESCRIBE ${dStatus[1]}`);
          }
        }

        done(null);
      } catch (e) {
        done(null);
      }
    });

    socket.on('error', () => done(null));
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
 * Probe RTSP on an IP across common RAVENNA ports, forward any SDP found.
 * streamNames: SAP-discovered stream names on this IP, used for /by-name/ URLs.
 */
async function probeRtspIp(ip, streamNames = []) {
  const RAVENNA_RTSP_PORTS = [554, 9010, 8554, 9020, 8000, 5000, 7272];
  let connected = false;

  for (const port of RAVENNA_RTSP_PORTS) {
    const reachable = await new Promise((resolve) => {
      const s = new net.Socket();
      s.setTimeout(1000);
      s.connect(port, ip, () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      s.on('timeout', () => { s.destroy(); resolve(false); });
    });

    if (!reachable) continue;
    connected = true;
    console.log(`[RTSP Probe] ${ip}:${port} TCP open - trying DESCRIBE`);

    const sdp = await rtspDescribe(ip, port, streamNames, 5000);
    if (sdp) {
      console.log(`[RTSP Probe] ${ip}:${port} → SDP found`);
      process.send({ type: 'ravenna-sdp', name: ip, sdp, sourceIp: ip });
      return;
    }
    console.log(`[RTSP Probe] ${ip}:${port} TCP open but no SDP`);
  }

  if (!connected) {
    console.log(`[RTSP Probe] ${ip}: no open TCP ports found`);
  } else {
    console.log(`[RTSP Probe] ${ip}: TCP ports open but no RTSP/SDP`);
  }
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
      probeRtspIp(msg.ip, msg.streamNames || []);
      break;
  }
});

process.on('disconnect', () => {
  stop();
  process.exit(0);
});

// Auto-start on load
init();
