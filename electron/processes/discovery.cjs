/**
 * Network Audio Discovery Child Process
 * Orchestrates mDNS, Dante ARC and RAVENNA RTSP discovery.
 *
 * Device state is maintained here and sent to the main process
 * via IPC messages of type 'dante-devices'.
 *
 * Incoming IPC messages:
 *   { type: 'init' }               — start mDNS browsing
 *   { type: 'stop' }               — stop all discovery
 *   { type: 'refresh' }            — restart discovery
 *   { type: 'probe-arc', ip }      — query ARC on a known IP (from SAP)
 *   { type: 'probe-rtsp', ip, streamNames } — probe RTSP on a known IP (from SAP)
 */

'use strict';

const arc  = require('../protocols/arc.cjs');
const rtsp = require('../protocols/rtsp.cjs');
const mdns = require('../protocols/mdns.cjs');

// Device registry: host/ip → device info
const devices   = new Map();
let updateTimer = null;
let mdnsHandle  = null;

// ─── Device parsing ──────────────────────────────────────────────────────────

/**
 * Build a normalised device object from an mDNS service record
 */
function parseService(service) {
  const txt    = service.txt || {};
  const family = service.family || 'unknown';

  const base = {
    name:           service.name,
    host:           service.host,
    addresses:      service.addresses || [],
    port:           service.port,
    protocolFamily: family,
  };

  if (family === 'dante') {
    return {
      ...base,
      model:        txt.model || null,
      manufacturer: txt.mf || txt.manufacturer || 'Audinate',
      sampleRate:   txt.rate ? parseInt(txt.rate) : 48000,
      txChannels:   txt.txc  ? parseInt(txt.txc)  : null,
      rxChannels:   txt.rxc  ? parseInt(txt.rxc)  : null,
      isDante:      true,
      isAES67:      txt.aes67 === '1' || txt.aes67 === 'true',
      isRAVENNA:    false,
      software:     txt.router_info === '"Dante Via"' ? 'Dante Via' : null,
    };
  }

  if (family === 'ravenna' || family === 'aes67') {
    return {
      ...base,
      model:          txt.model || txt.dname || null,
      manufacturer:   txt.mf || txt.manufacturer || null,
      sampleRate:     txt.sr ? parseInt(txt.sr) : 48000,
      txChannels:     txt.src ? parseInt(txt.src) : null,
      rxChannels:     txt.snk ? parseInt(txt.snk) : null,
      ptpGrandmaster: txt.ptp || null,
      isDante:        false,
      isAES67:        true,
      isRAVENNA:      family === 'ravenna',
      software:       txt.ver || null,
    };
  }

  return base;
}

// ─── IPC output ──────────────────────────────────────────────────────────────

function sendUpdate() {
  const list = [];

  for (const device of devices.values()) {
    list.push({
      host:           device.host,
      name:           device.name,
      addresses:      device.addresses || [],
      port:           device.port,
      protocolFamily: device.protocolFamily || 'dante',
      manufacturer:   device.manufacturer  || (device.isDante ? 'Audinate' : null),
      model:          device.model         || null,
      sampleRate:     device.sampleRate    || 48000,
      txChannels:     device.txChannels    ?? null,
      rxChannels:     device.rxChannels    ?? null,
      isDante:        device.isDante       !== false,
      isAES67:        device.isAES67       || false,
      isRAVENNA:      device.isRAVENNA     || false,
      software:       device.software      || null,
      requiresAES67:  !device.isAES67 && device.protocolFamily === 'dante',
    });
  }

  process.send({ type: 'dante-devices', devices: list });
}

function scheduleUpdate() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(sendUpdate, 500);
}

// ─── mDNS callbacks ──────────────────────────────────────────────────────────

function onServiceUp(service) {
  console.log(`[Discovery] Found: ${service.name} (${service.type || service.family})`);

  const device   = parseService(service);
  const existing = devices.get(service.host);

  devices.set(service.host, existing ? { ...existing, ...device } : device);
  scheduleUpdate();

  if (!existing) {
    // Enrich Dante devices with ARC channel data
    if (device.isDante) enrichWithArc(device);
    // Enrich RAVENNA devices with RTSP SDP
    if (device.isRAVENNA) enrichWithRtsp(device);
  }
}

function onServiceDown(service) {
  console.log(`[Discovery] Lost: ${service.name}`);
  if (service.host) {
    devices.delete(service.host);
    scheduleUpdate();
  }
}

// ─── ARC enrichment ──────────────────────────────────────────────────────────

async function enrichWithArc(device) {
  const ip      = device.addresses.find(a => a.includes('.'));
  const arcPort = device.port || arc.DEFAULT_PORT;
  if (!ip) return;

  const result = await arc.query(ip, arcPort);
  if (!result) {
    console.log(`[ARC] ${device.name} (${ip}:${arcPort}): no response`);
    return;
  }

  const stored = devices.get(device.host);
  if (!stored) return;

  if (result.deviceName)               stored.name       = result.deviceName;
  if (result.model)                    stored.model      = result.model;
  if (result.txChannels !== undefined) stored.txChannels = result.txChannels;
  if (result.rxChannels !== undefined) stored.rxChannels = result.rxChannels;

  devices.set(device.host, stored);
  console.log(`[ARC] ${stored.name} (${ip}): ${stored.txChannels ?? '?'}TX / ${stored.rxChannels ?? '?'}RX | model=${stored.model || '-'}`);
  scheduleUpdate();
}

// ─── RTSP enrichment ─────────────────────────────────────────────────────────

async function enrichWithRtsp(device, streamNames = []) {
  const ip = device.addresses.find(a => a.includes('.'));
  if (!ip) return;

  const result = await rtsp.probe(ip, streamNames);
  if (!result) return;

  console.log(`[RTSP] SDP from ${device.name} (${ip})`);
  process.send({ type: 'ravenna-sdp', name: device.name, sdp: result.sdp, sourceIp: ip });
}

// ─── IP-based probes (triggered from SAP source IPs) ─────────────────────────

async function probeArcIp(ip) {
  const result = await arc.query(ip, arc.DEFAULT_PORT);
  if (!result) return;

  console.log(`[ARC Probe] ${ip}: name="${result.deviceName || '-'}" model="${result.model || '-'}" ${result.txChannels ?? '?'}TX/${result.rxChannels ?? '?'}RX`);

  const existing = devices.get(ip) || { host: ip, addresses: [ip], port: arc.DEFAULT_PORT };
  if (result.deviceName)               existing.name       = result.deviceName;
  if (result.model)                    existing.model      = result.model;
  if (result.txChannels !== undefined) existing.txChannels = result.txChannels;
  if (result.rxChannels !== undefined) existing.rxChannels = result.rxChannels;
  existing.isDante        = true;
  existing.protocolFamily = 'dante';
  existing.manufacturer   = 'Audinate';

  devices.set(ip, existing);
  scheduleUpdate();
}

async function probeRtspIp(ip, streamNames = []) {
  const result = await rtsp.probe(ip, streamNames);
  if (!result) return;

  process.send({ type: 'ravenna-sdp', name: ip, sdp: result.sdp, sourceIp: ip });
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

function init() {
  stop();
  mdnsHandle = mdns.browse({ onUp: onServiceUp, onDown: onServiceDown });
  process.send({ type: 'status', status: 'browsing' });
}

function stop() {
  if (mdnsHandle) { mdnsHandle.stop(); mdnsHandle = null; }
  devices.clear();
  clearTimeout(updateTimer);
}

function refresh() {
  console.log('[Discovery] Refreshing...');
  stop();
  init();
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

process.on('message', (msg) => {
  switch (msg.type) {
    case 'init':       init();                                    break;
    case 'stop':       stop();                                    break;
    case 'refresh':    refresh();                                 break;
    case 'probe-arc':  probeArcIp(msg.ip);                       break;
    case 'probe-rtsp': probeRtspIp(msg.ip, msg.streamNames || []); break;
  }
});

process.on('disconnect', () => { stop(); process.exit(0); });

// Auto-start
init();
