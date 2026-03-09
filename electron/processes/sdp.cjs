/**
 * SDP/SAP Discovery Child Process
 * Handles multicast SAP discovery and manual SDP parsing
 * Based on philhartung/aes67-monitor architecture with sdp-transform
 */

const crypto      = require('crypto');
const sdpTransform = require('sdp-transform');
const sap         = require('../protocols/sap.cjs');
const aes67       = require('../protocols/aes67.cjs');

let sapHandle       = null;
let currentInterface = null;
let sessions        = {};
let deleteTimeout   = 5 * 60 * 1000; // 5 minutes default

/**
 * Parse and validate SDP — delegates to aes67.cjs
 */
function parseSdp(sdp) {
  return aes67.validateSdp(sdp, sdp.raw || null);
}

/**
 * Handle incoming SAP message
 */
function handleSapMessage(message, rinfo) {
  const parsed = sap.parsePacket(message);
  if (!parsed) return;

  const { isDelete, rawSdp } = parsed;
  let sdp;

  try {
    sdp = sdpTransform.parse(rawSdp);
  } catch (e) {
    console.error('[SDP] Parse error:', e.message);
    return;
  }

  if (!sdp.origin || !sdp.name) return;

  // Generate unique ID from origin
  const id = sap.sessionId(sdp.origin);

  if (isDelete) {
    delete sessions[id];
    sendUpdate();
    return;
  }

  // Don't overwrite manual streams
  if (sessions[id]?.manual) return;

  const isNew = !sessions[id];

  // Store session
  sdp.raw = rawSdp;
  sdp.id = id;
  sdp.lastSeen = Date.now();
  sdp.manual = false;
  sdp.sourceType = 'sap';
  sdp.sapSourceIp = rinfo?.address || null;

  const parsedSap = parseSdp(sdp);

  // Secondary dedup: if an RTSP-sourced stream with same mcast+port already exists
  // (arrived before this SAP), merge instead of creating a duplicate entry.
  if (isNew && parsedSap.mcast && parsedSap.port) {
    const existing = Object.values(sessions).find(
      s => !s.manual && s.mcast === parsedSap.mcast && s.port === parsedSap.port
    );
    if (existing) {
      existing.lastSeen = Date.now();
      existing.sapSourceIp = parsedSap.sapSourceIp || existing.sapSourceIp;
      console.log(`[SDP] SAP duplicate suppressed — already have ${existing.name} on ${parsedSap.mcast}:${parsedSap.port} (via RTSP)`);
      sendUpdate();
      return;
    }
  }

  sessions[id] = parsedSap;

  if (isNew) {
    const s = sessions[id];
    console.log(`[SDP] New stream: ${s.name || id} | mcast=${s.mcast}:${s.port} | src=${s.deviceIp || s.sapSourceIp || '?'} | tool=${s.tool || '-'}`);
    if (s.ptpGrandmaster) {
      console.log(`[SDP] PTP: ${s.ptpVersion} GM=${s.ptpGrandmaster} Domain=${s.ptpDomain}`);
    }
  }

  sendUpdate();
}

/**
 * Add manual stream from SDP text
 * @param {string}  rawSdp
 * @param {boolean} [announce=false]  If true, re-announce on the network every 30s
 */
function addManualStream(rawSdp, announce = false) {
  let sdp;
  
  try {
    sdp = sdpTransform.parse(rawSdp);
  } catch (e) {
    console.error('[SDP] Manual parse error:', e.message);
    return;
  }

  if (!sdp.origin || !sdp.name) {
    console.error('[SDP] Invalid SDP: missing origin or name');
    return;
  }

  const id = crypto
    .createHash('md5')
    .update(JSON.stringify(sdp.origin))
    .digest('hex');

  sdp.raw = rawSdp;
  sdp.id = id;
  sdp.lastSeen = Date.now();
  sdp.manual = true;
  sdp.announce = announce;
  sdp.sourceType = 'manual';

  sessions[id] = parseSdp(sdp);
  sendUpdate();
}

/**
 * Add stream discovered via RTSP DESCRIBE (RAVENNA/AES67 devices)
 * Treated as SAP stream but sourced from RTSP
 */
function addRavennaStream(rawSdp, sourceIp) {
  let sdp;

  try {
    sdp = sdpTransform.parse(rawSdp);
  } catch (e) {
    console.error('[SDP] RTSP parse error:', e.message);
    return;
  }

  if (!sdp.origin || !sdp.name) {
    console.error('[SDP] RTSP SDP missing origin or name');
    return;
  }

  const id = crypto
    .createHash('md5')
    .update(JSON.stringify(sdp.origin))
    .digest('hex');

  // Primary dedup: exact origin match
  if (sessions[id]) {
    sessions[id].lastSeen = Date.now();
    return;
  }

  // Secondary dedup: same stream announced via SAP already present (different sessionVersion).
  // A Dante+AES67 device sends both SAP multicast and responds to RTSP DESCRIBE — the origin
  // sessionVersion may differ between the two, producing a different MD5. Deduplicate by
  // matching the multicast address + port from the parsed SDP.
  const parsed = parseSdp({ ...sdp, raw: rawSdp, id, lastSeen: Date.now(), manual: false, sourceType: 'sap', sapSourceIp: sourceIp || null });
  if (parsed.mcast && parsed.port) {
    const existing = Object.values(sessions).find(
      s => !s.manual && s.mcast === parsed.mcast && s.port === parsed.port
    );
    if (existing) {
      console.log(`[SDP] RTSP duplicate suppressed — already have ${existing.name} on ${parsed.mcast}:${parsed.port} (via SAP)`);
      existing.lastSeen = Date.now();
      return;
    }
  }

  sessions[id] = parsed;
  console.log(`[SDP] RAVENNA stream via RTSP: ${parsed.name} (${parsed.mcast}:${parsed.port})`);
  sendUpdate();
}

/**
 * Remove stream by ID
 */
function removeStream(streamId) {
  delete sessions[streamId];
  sendUpdate();
}

/**
 * Initialize SAP socket and join multicast
 */
function init(address) {
  if (sapHandle) sapHandle.close();

  currentInterface = address;

  sapHandle = sap.listen(
    address,
    handleSapMessage,
    (err) => {
      console.error('[SDP Socket Error]', err.message);
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        process.send({
          type: 'port-conflict',
          port: sap.PORT,
          code: err.code,
          message: `Port ${sap.PORT} is already in use or access denied.`,
        });
      } else {
        process.send({ type: 'error', message: err.message });
      }
    }
  );

  console.log(`[SDP] Listening on ${address}`);
  process.send({ type: 'status', status: 'connected', port: sap.PORT });
}

/**
 * Change network interface
 */
function setInterface(address) {
  if (currentInterface === address) return;

  const oldInterface = currentInterface;
  currentInterface   = address;

  // Clear non-manual sessions
  for (const id of Object.keys(sessions)) {
    if (!sessions[id].manual) delete sessions[id];
  }

  if (sapHandle) {
    try {
      sapHandle.changeInterface(address, oldInterface);
    } catch (e) {
      console.error('[SDP] Interface change error:', e.message);
      process.send({ type: 'error', message: e.message });
    }
  }

  sendUpdate();
}

/**
 * Prune expired sessions and send update
 */
function sendUpdate() {
  const now = Date.now();
  
  // Prune expired non-manual sessions
  for (const id of Object.keys(sessions)) {
    if (!sessions[id].manual && (now - sessions[id].lastSeen) > deleteTimeout) {
      delete sessions[id];
    }
  }

  // Convert to array and send
  const streams = Object.values(sessions);
  process.send({ type: 'streams', streams });
}

// Periodic prune (every 5s as per Digisynthetic reference)
setInterval(sendUpdate, 5000);

// Re-announce manual streams every 30s (per philhartung/aes67-monitor reference)
setInterval(() => {
  if (!currentInterface) return;
  for (const id of Object.keys(sessions)) {
    const s = sessions[id];
    if (s.announce && s.raw && s.origin) {
      sap.announce(s.raw, s.origin.address || currentInterface);
    }
  }
}, 30000);

// IPC message handler
process.on('message', (msg) => {
  switch (msg.type) {
    case 'init':
      init(msg.address);
      break;
    case 'set-interface':
      setInterface(msg.address);
      break;
    case 'add-manual':
      addManualStream(msg.sdp);
      break;
    case 'add-stream':
      addRavennaStream(msg.sdp, msg.sourceIp);
      break;
    case 'remove':
      removeStream(msg.streamId);
      break;
    case 'set-timeout':
      deleteTimeout = msg.timeout * 1000;
      break;
  }
});

process.on('disconnect', () => {
  if (sapHandle) sapHandle.close();
  process.exit(0);
});
