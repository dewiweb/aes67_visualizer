/**
 * Network Audio Discovery Child Process
 * Orchestrates mDNS, Dante ARC and RAVENNA RTSP discovery.
 *
 * All discovered devices are merged into a single registry keyed by IP address.
 * Each source (mDNS service types, ARC, RTSP, SAP probe) contributes fields
 * to a unified device model — later data never overwrites richer existing data.
 *
 * Unified device model fields:
 *   ip            {string}   Primary IPv4 address (registry key)
 *   host          {string}   mDNS hostname (e.g. "device.local.")
 *   name          {string}   Human-readable device name
 *   manufacturer  {string}   e.g. "Powersoft", "Amadeus (Holophonix)", "Audinate"
 *   model         {string}   Device model string
 *   software      {string}   Firmware/software label
 *   protocolFamily {string}  'dante' | 'ravenna' | 'aes67' | 'unknown'
 *   isDante       {boolean}
 *   isAES67       {boolean}
 *   isRAVENNA     {boolean}
 *   sampleRate    {number}   Hz
 *   txChannels    {number|null}
 *   rxChannels    {number|null}
 *   txChannelNames [{id,name}]
 *   rxChannelNames [{id,name,txChannelName,txHost,subscribed}]
 *   arcpVers      {string}   Dante ARC protocol version
 *   routerVers    {string}   Dante firmware version
 *   routerInfo    {string}   Dante router_info TXT field
 *   ptpGrandmaster {string}  From mDNS TXT (RAVENNA) or SAP SDP
 *   discoveredBy  {string[]} Sources that contributed info
 *   lastSeen      {number}   Date.now() of most recent update
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

// Device registry: IP → unified device object
const devices   = new Map();
let updateTimer    = null;
let mdnsHandle     = null;
let announceServer = null;

// ─── Unified device model helpers ────────────────────────────────────────────

/**
 * Return the first non-null/non-empty value from the list.
 */
function pick(...values) {
  for (const v of values) {
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

/**
 * Merge a patch into an existing device record.
 * Rules:
 *  - Scalar fields: keep existing if non-null, otherwise take patch value
 *  - Boolean flags: OR (once true, stays true)
 *  - Arrays (addresses, channelNames): keep longest/non-empty
 *  - discoveredBy: union of sources
 */
function mergeDevice(existing, patch) {
  const merged = { ...existing };

  // Scalar fields — only fill in if currently empty
  const scalars = ['name', 'manufacturer', 'model', 'software',
                   'arcpVers', 'routerVers', 'routerInfo', 'ptpGrandmaster', 'macAddress'];
  for (const k of scalars) {
    if (!merged[k] && patch[k]) merged[k] = patch[k];
  }

  // protocolFamily: prefer more specific (ravenna/aes67 > dante > unknown)
  const familyRank = { ravenna: 3, aes67: 3, dante: 2, unknown: 1 };
  if ((familyRank[patch.protocolFamily] || 0) > (familyRank[merged.protocolFamily] || 0)) {
    merged.protocolFamily = patch.protocolFamily;
  }

  // Numeric fields — take patch if existing is null/0
  if (merged.sampleRate == null && patch.sampleRate) merged.sampleRate = patch.sampleRate;
  if (merged.txChannels == null && patch.txChannels != null) merged.txChannels = patch.txChannels;
  if (merged.rxChannels == null && patch.rxChannels != null) merged.rxChannels = patch.rxChannels;

  // Boolean flags — OR
  if (patch.isDante)   merged.isDante   = true;
  if (patch.isAES67)   merged.isAES67   = true;
  if (patch.isRAVENNA) merged.isRAVENNA = true;

  // Addresses — keep union
  const addrSet = new Set([...(merged.addresses || []), ...(patch.addresses || [])]);
  merged.addresses = [...addrSet].filter(Boolean);

  // Channel names — keep if incoming has more detail
  if ((patch.txChannelNames || []).length > (merged.txChannelNames || []).length) {
    merged.txChannelNames = patch.txChannelNames;
  }
  if ((patch.rxChannelNames || []).length > (merged.rxChannelNames || []).length) {
    merged.rxChannelNames = patch.rxChannelNames;
  }

  // host: keep first non-dot value
  if (!merged.host || merged.host === '.') merged.host = patch.host || merged.host;

  // discoveredBy: union
  const bySet = new Set([...(merged.discoveredBy || []), ...(patch.discoveredBy || [])]);
  merged.discoveredBy = [...bySet];

  merged.lastSeen = Date.now();
  return merged;
}

/**
 * Upsert a device patch into the registry by IP.
 * Returns the merged device.
 */
function upsert(ip, patch) {
  if (!ip) return null;
  const existing = devices.get(ip);
  const result   = existing ? mergeDevice(existing, patch) : { ...emptyDevice(ip), ...patch, lastSeen: Date.now() };
  devices.set(ip, result);
  return result;
}

/**
 * Create an empty device skeleton for a given IP.
 */
function emptyDevice(ip) {
  return {
    ip,
    host:           null,
    name:           ip,
    manufacturer:   null,
    model:          null,
    software:       null,
    protocolFamily: 'unknown',
    isDante:        false,
    isAES67:        false,
    isRAVENNA:      false,
    sampleRate:     null,
    txChannels:     null,
    rxChannels:     null,
    txChannelNames: [],
    rxChannelNames: [],
    arcpVers:       null,
    routerVers:     null,
    routerInfo:     null,
    ptpGrandmaster: null,
    macAddress:     null,
    addresses:      [ip],
    discoveredBy:   [],
    lastSeen:       Date.now(),
  };
}

// ─── Device parsing from mDNS service records ─────────────────────────────────

/**
 * Parse an mDNS service record into a device patch.
 */
function parseService(service) {
  const txt    = service.txt || {};
  const family = service.family || 'unknown';
  const ip     = (service.addresses || []).find(a => /^\d+\./.test(a)) || null;

  const base = {
    ip,
    host:           service.host || null,
    addresses:      service.addresses || [],
    protocolFamily: family,
    discoveredBy:   [`mdns:${service.type || family}`],
  };

  if (family === 'dante') {
    // Normalise manufacturer — some firmwares have typos
    const rawMf = txt.mf || txt.manufacturer || '';
    const manufacturer = pick(
      rawMf.replace(/Powersft/i, 'Powersoft').replace(/Amadeus/i, 'Amadeus (Holophonix)'),
      'Audinate'
    );

    // Clean model (Powersoft sends numeric IDs like _0000000700000003)
    const rawModel = txt.model || null;
    const model = rawModel && rawModel.startsWith('_') ? null : rawModel;

    // Detect AES67 mode
    const routerInfo = (txt.router_info || '').toLowerCase();
    const isAES67 = txt.aes67 === '1' || txt.aes67 === 'true' ||
                    routerInfo.includes('aes67') ||
                    routerInfo.includes('danteep');

    // Detect software label
    let software = null;
    if (routerInfo.includes('dante via'))        software = 'Dante Via';
    else if (routerInfo.includes('danteep'))     software = 'Dante Embedded Platform';
    else if (routerInfo.includes('ultimox'))     software = `Powersoft ${txt.router_info || ''}`.trim();
    else if (routerInfo.includes('dcm'))         software = `Dante Firmware ${txt.router_vers || ''}`.trim();

    // Name: for _arc service the service name is the device name
    // For _chan it's "ChannelName@DeviceName" — skip those
    const isChanService = (service.type || '').includes('chan');
    const name = isChanService ? null : service.name;

    // MAC address: from _netaudio-cmc._udp TXT 'id' field (e.g. "001dc1fffe506217")
    const macRaw = txt.id || null;
    const macAddress = macRaw && /^[0-9a-f]{12,16}$/i.test(macRaw) ? macRaw : null;

    return {
      ...base,
      name,
      manufacturer,
      model,
      software,
      sampleRate:  txt.rate ? parseInt(txt.rate) : null,
      txChannels:  txt.txc  ? parseInt(txt.txc)  : null,
      rxChannels:  txt.rxc  ? parseInt(txt.rxc)  : null,
      isDante:     true,
      isAES67,
      isRAVENNA:   false,
      routerInfo:  txt.router_info || null,
      routerVers:  txt.router_vers || null,
      arcpVers:    txt.arcp_vers   || null,
      macAddress,
    };
  }

  if (family === 'ravenna' || family === 'aes67') {
    const d = ravenna.parseDevice(service.name, service.host, service.addresses || [], service.port, txt);
    return { ...base, ...d, discoveredBy: base.discoveredBy };
  }

  return base;
}

// ─── IPC output ──────────────────────────────────────────────────────────────

function sendUpdate() {
  const list = Array.from(devices.values()).map(d => ({
    ip:             d.ip,
    host:           d.host,
    name:           d.name || d.ip,
    addresses:      d.addresses || [],
    protocolFamily: d.protocolFamily || 'unknown',
    manufacturer:   d.manufacturer  || null,
    model:          d.model         || null,
    software:       d.software      || null,
    sampleRate:     d.sampleRate    || null,
    txChannels:     d.txChannels    ?? null,
    rxChannels:     d.rxChannels    ?? null,
    txChannelNames: d.txChannelNames || [],
    rxChannelNames: d.rxChannelNames || [],
    isDante:        d.isDante    || false,
    isAES67:        d.isAES67   || false,
    isRAVENNA:      d.isRAVENNA || false,
    arcpVers:       d.arcpVers  || null,
    routerVers:     d.routerVers || null,
    routerInfo:     d.routerInfo || null,
    ptpGrandmaster: d.ptpGrandmaster || null,
    macAddress:     d.macAddress || null,
    discoveredBy:   d.discoveredBy || [],
    lastSeen:       d.lastSeen || Date.now(),
  }));

  process.send({ type: 'dante-devices', devices: list });
}

function scheduleUpdate() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(sendUpdate, 500);
}

// ─── mDNS callbacks ──────────────────────────────────────────────────────────

function onServiceUp(service) {
  const patch = parseService(service);
  const ip    = patch.ip;
  if (!ip) return; // skip services we couldn't resolve to an IP

  console.log(`[Discovery] ${service.name} (${service.type||service.family}) ip=${ip}`);

  const isNew = !devices.has(ip);
  const merged = upsert(ip, patch);
  scheduleUpdate();

  // Only trigger enrichment once per device IP
  if (isNew) {
    if (merged.isDante)   enrichWithArc(merged);
    if (merged.isRAVENNA) enrichWithRtsp(merged);
  }
}

function onServiceDown(service) {
  const ip = (service.addresses || []).find(a => /^\d+\./.test(a));
  console.log(`[Discovery] Lost: ${service.name} ip=${ip || '?'}`);
  if (ip) {
    devices.delete(ip);
    scheduleUpdate();
  }
}

// ─── ARC enrichment ──────────────────────────────────────────────────────────

async function enrichWithArc(device) {
  const ip      = device.ip || (device.addresses || []).find(a => /^\d+\./.test(a));
  const arcPort = device.port || arc.DEFAULT_PORT;
  if (!ip) return;

  const result = await arc.query(ip, arcPort);
  if (!result) {
    console.log(`[ARC] ${device.name} (${ip}): no response`);
    return;
  }

  upsert(ip, {
    name:       result.deviceName || undefined,
    model:      result.model      || undefined,
    txChannels: result.txChannels ?? undefined,
    rxChannels: result.rxChannels ?? undefined,
    isDante:    true,
    discoveredBy: ['arc'],
  });
  const stored = devices.get(ip);
  console.log(`[ARC] ${stored.name} (${ip}): ${stored.txChannels ?? '?'}TX / ${stored.rxChannels ?? '?'}RX`);
  scheduleUpdate();

  const txCount = result.txChannels || 0;
  const rxCount = result.rxChannels || 0;
  if (txCount > 0 || rxCount > 0) {
    const [txChs, rxChs] = await Promise.all([
      txCount > 0 ? arc.getTxChannels(ip, arcPort, txCount) : Promise.resolve([]),
      rxCount > 0 ? arc.getRxChannels(ip, arcPort, rxCount) : Promise.resolve([]),
    ]);
    upsert(ip, {
      txChannelNames: txChs.length > 0 ? txChs : undefined,
      rxChannelNames: rxChs.length > 0 ? rxChs : undefined,
    });
    if (txChs.length > 0) {
      const s = devices.get(ip);
      console.log(`[ARC] ${s.name} TX: ${txChs.slice(0, 4).map(c => c.name || `ch${c.id}`).join(', ')}${txChs.length > 4 ? '...' : ''}`);
    }
    scheduleUpdate();
  }
}

// ─── RTSP enrichment ─────────────────────────────────────────────────────────

async function enrichWithRtsp(device, streamNames = []) {
  const ip = device.ip || (device.addresses || []).find(a => /^\d+\./.test(a));
  if (!ip) return;

  const port = device.port || ravenna.RTSP_PORT;
  const result = await rtsp.describe(ip, port, streamNames, 5000);
  if (!result) return;

  console.log(`[RTSP] SDP from ${device.name} (${ip})`);
  upsert(ip, { discoveredBy: ['rtsp'] });
  process.send({ type: 'ravenna-sdp', name: device.name, sdp: result, sourceIp: ip });
}

// ─── IP-based probes (triggered from SAP source IPs) ─────────────────────────

async function probeArcIp(ip) {
  const port   = arc.DEFAULT_PORT;
  const result = await arc.query(ip, port);
  if (!result) return;

  console.log(`[ARC Probe] ${ip}: name="${result.deviceName || '-'}" ${result.txChannels ?? '?'}TX/${result.rxChannels ?? '?'}RX`);

  upsert(ip, {
    name:           result.deviceName || undefined,
    model:          result.model      || undefined,
    txChannels:     result.txChannels ?? undefined,
    rxChannels:     result.rxChannels ?? undefined,
    isDante:        true,
    protocolFamily: 'dante',
    manufacturer:   'Audinate',
    discoveredBy:   ['arc-probe'],
  });
  scheduleUpdate();

  const txCount = result.txChannels || 0;
  const rxCount = result.rxChannels || 0;
  if (txCount > 0 || rxCount > 0) {
    const [txChs, rxChs] = await Promise.all([
      txCount > 0 ? arc.getTxChannels(ip, port, txCount) : Promise.resolve([]),
      rxCount > 0 ? arc.getRxChannels(ip, port, rxCount) : Promise.resolve([]),
    ]);
    if (txChs.length > 0) {
      console.log(`[ARC Probe] ${ip} TX: ${txChs.slice(0, 4).map(c => c.name || `ch${c.id}`).join(', ')}${txChs.length > 4 ? '...' : ''}`);
    }
    if (rxChs.length > 0) {
      const subscribed = rxChs.filter(c => c.subscribed);
      if (subscribed.length > 0) {
        console.log(`[ARC Probe] ${ip} RX subs: ${subscribed.slice(0, 4).map(c => `${c.name}<-${c.txHost || '?'}`).join(', ')}`);
      }
    }
    upsert(ip, {
      txChannelNames: txChs.length > 0 ? txChs : undefined,
      rxChannelNames: rxChs.length > 0 ? rxChs : undefined,
    });
    scheduleUpdate();
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

  // Start RTSP ANNOUNCE server — receives SDP pushed by RAVENNA devices
  announceServer = rtsp.createAnnounceServer([554, 9010]);
  announceServer.on('announce', ({ sdp, sourceIp, url }) => {
    // Upsert device so it appears in the registry even without mDNS
    upsert(sourceIp, {
      ip:             sourceIp,
      protocolFamily: 'ravenna',
      isRAVENNA:      true,
      isAES67:        true,
      discoveredBy:   ['rtsp-announce'],
    });
    scheduleUpdate();
    process.send({ type: 'ravenna-sdp', name: sourceIp, sdp, sourceIp });
  });

  process.send({ type: 'status', status: 'browsing' });
}

function stop() {
  if (mdnsHandle)     { mdnsHandle.stop(); mdnsHandle = null; }
  if (announceServer) { announceServer.stop(); announceServer = null; }
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
