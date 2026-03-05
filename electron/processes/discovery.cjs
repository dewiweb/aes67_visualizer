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

const arc     = require('../protocols/arc.cjs');
const rtsp    = require('../protocols/rtsp.cjs');
const mdns    = require('../protocols/mdns.cjs');
const ravenna = require('../protocols/ravenna.cjs');

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
    // Normalise manufacturer field — some firmwares have typos
    const rawMf = txt.mf || txt.manufacturer || '';
    const manufacturer = rawMf
      .replace(/Powersft/i, 'Powersoft')
      .replace(/Amadeus/i,  'Amadeus (Holophonix)') ||
      'Audinate';

    // Clean model field (Powersoft sends a numeric ID like _0000000700000003)
    const rawModel = txt.model || null;
    const model = rawModel && rawModel.startsWith('_') ? null : rawModel;

    // Detect AES67 mode from various fields
    const routerInfo = (txt.router_info || '').toLowerCase();
    const isAES67 = txt.aes67 === '1' || txt.aes67 === 'true' ||
                    routerInfo.includes('aes67') ||
                    routerInfo.includes('danteep'); // Dante Embedded Platform (Holophonix)

    // Detect software
    let software = null;
    if (routerInfo.includes('dante via')) software = 'Dante Via';
    else if (routerInfo.includes('danteep')) software = 'Dante Embedded Platform';
    else if (routerInfo.includes('dcm')) software = `Dante Controller Module (${txt.router_vers || ''})`.trim();

    return {
      ...base,
      model,
      manufacturer,
      sampleRate:   txt.rate ? parseInt(txt.rate) : 48000,
      txChannels:   txt.txc  ? parseInt(txt.txc)  : null,
      rxChannels:   txt.rxc  ? parseInt(txt.rxc)  : null,
      isDante:      true,
      isAES67,
      isRAVENNA:    false,
      software,
      routerInfo:   txt.router_info || null,
      routerVers:   txt.router_vers || null,
      arcpVers:     txt.arcp_vers  || null,
    };
  }

  if (family === 'ravenna' || family === 'aes67') {
    return ravenna.parseDevice(service.name, service.host, service.addresses || [], service.port, txt);
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
      txChannels:      device.txChannels     ?? null,
      rxChannels:      device.rxChannels     ?? null,
      txChannelNames:  device.txChannelNames || [],
      rxChannelNames:  device.rxChannelNames || [],
      isDante:         device.isDante        !== false,
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
  console.log(`[Discovery] Found: ${service.name} (${service.type||service.family}) host=${service.host} ip=${(service.addresses||[]).join(',')}`);

  const device   = parseService(service);
  const existing = devices.get(service.host);

  // Merge: keep best data from multiple service types for same host
  const merged = existing ? { ...existing, ...device } : device;
  // Never lose addresses or channel counts from previous records
  if (existing) {
    if (!merged.addresses.length && existing.addresses.length) merged.addresses = existing.addresses;
    if (merged.txChannels === null && existing.txChannels !== null) merged.txChannels = existing.txChannels;
    if (merged.rxChannels === null && existing.rxChannels !== null) merged.rxChannels = existing.rxChannels;
  }
  devices.set(service.host, merged);
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

  // Fetch channel names (same as probeArcIp)
  const txCount = result.txChannels || 0;
  const rxCount = result.rxChannels || 0;
  if (txCount > 0 || rxCount > 0) {
    const [txChs, rxChs] = await Promise.all([
      txCount > 0 ? arc.getTxChannels(ip, arcPort, txCount) : Promise.resolve([]),
      rxCount > 0 ? arc.getRxChannels(ip, arcPort, rxCount) : Promise.resolve([]),
    ]);
    const s = devices.get(device.host);
    if (s) {
      if (txChs.length > 0) {
        s.txChannelNames = txChs;
        console.log(`[ARC] ${s.name} TX channels: ${txChs.slice(0, 4).map(c => c.name || `ch${c.id}`).join(', ')}${txChs.length > 4 ? '...' : ''}`);
      }
      if (rxChs.length > 0) {
        s.rxChannelNames = rxChs;
      }
      devices.set(device.host, s);
      scheduleUpdate();
    }
  }
}

// ─── RTSP enrichment ─────────────────────────────────────────────────────────

async function enrichWithRtsp(device, streamNames = []) {
  const ip = device.addresses.find(a => a.includes('.'));
  if (!ip) return;

  const port = device.port || ravenna.RTSP_PORT;
  const result = await rtsp.describe(ip, port, streamNames, 5000);
  if (!result) return;

  console.log(`[RTSP] SDP from ${device.name} (${ip})`);
  process.send({ type: 'ravenna-sdp', name: device.name, sdp: result, sourceIp: ip });
}

// ─── IP-based probes (triggered from SAP source IPs) ─────────────────────────

async function probeArcIp(ip) {
  const port   = arc.DEFAULT_PORT;
  const result = await arc.query(ip, port);
  if (!result) return;

  console.log(`[ARC Probe] ${ip}: name="${result.deviceName || '-'}" model="${result.model || '-'}" ${result.txChannels ?? '?'}TX/${result.rxChannels ?? '?'}RX`);

  const existing = devices.get(ip) || { host: ip, addresses: [ip], port };
  if (result.deviceName)               existing.name       = result.deviceName;
  if (result.model)                    existing.model      = result.model;
  if (result.txChannels !== undefined) existing.txChannels = result.txChannels;
  if (result.rxChannels !== undefined) existing.rxChannels = result.rxChannels;
  existing.isDante        = true;
  existing.protocolFamily = 'dante';
  existing.manufacturer   = 'Audinate';

  devices.set(ip, existing);
  scheduleUpdate();

  // Fetch TX and RX channel names in parallel (non-blocking — update again when done)
  const txCount = result.txChannels || 0;
  const rxCount = result.rxChannels || 0;
  if (txCount > 0 || rxCount > 0) {
    const [txChs, rxChs] = await Promise.all([
      txCount > 0 ? arc.getTxChannels(ip, port, txCount) : Promise.resolve([]),
      rxCount > 0 ? arc.getRxChannels(ip, port, rxCount) : Promise.resolve([]),
    ]);

    const stored = devices.get(ip);
    if (stored) {
      if (txChs.length > 0) {
        stored.txChannelNames = txChs;
        console.log(`[ARC Probe] ${ip} TX channels: ${txChs.slice(0, 4).map(c => c.name || `ch${c.id}`).join(', ')}${txChs.length > 4 ? '...' : ''}`);
      }
      if (rxChs.length > 0) {
        stored.rxChannelNames = rxChs;
        const subscribed = rxChs.filter(c => c.subscribed);
        if (subscribed.length > 0) {
          console.log(`[ARC Probe] ${ip} RX subscriptions: ${subscribed.slice(0, 4).map(c => `${c.name}←${c.txHost || '?'}`).join(', ')}`);
        }
      }
      devices.set(ip, stored);
      scheduleUpdate();
    }
  }
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
