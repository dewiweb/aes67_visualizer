/**
 * SDP/SAP Discovery Child Process
 * Handles multicast SAP discovery and manual SDP parsing
 * Based on philhartung/aes67-monitor architecture with sdp-transform
 */

const dgram = require('dgram');
const crypto = require('crypto');
const sdpTransform = require('sdp-transform');

const SAP_MULTICAST = '239.255.255.255';
const SAP_PORT = 9875;
const SUPPORTED_SAMPLE_RATES = [44100, 48000, 88200, 96000, 192000];

let socket = null;
let currentInterface = null;
let sessions = {};
let deleteTimeout = 5 * 60 * 1000; // 5 minutes default

/**
 * Parse and validate SDP for AES67 compatibility
 */
function parseSdp(sdp) {
  // Check media support
  if (!sdp.media || sdp.media.length === 0) {
    sdp.isSupported = false;
    sdp.unsupportedReason = 'No media section';
    return sdp;
  }

  for (const media of sdp.media) {
    if (media.type !== 'audio' || media.protocol !== 'RTP/AVP') {
      sdp.isSupported = false;
      sdp.unsupportedReason = 'Unsupported media type';
      return sdp;
    }

    if (!media.rtp || media.rtp.length !== 1) {
      sdp.isSupported = false;
      sdp.unsupportedReason = 'Unsupported rtpmap';
      return sdp;
    }

    const rtp = media.rtp[0];
    
    if (!SUPPORTED_SAMPLE_RATES.includes(rtp.rate)) {
      sdp.isSupported = false;
      sdp.unsupportedReason = `Unsupported sample rate: ${rtp.rate}`;
      return sdp;
    }

    if (rtp.codec !== 'L24' && rtp.codec !== 'L16') {
      sdp.isSupported = false;
      sdp.unsupportedReason = `Unsupported codec: ${rtp.codec}`;
      return sdp;
    }

    if (rtp.encoding < 1 || rtp.encoding > 64) {
      sdp.isSupported = false;
      sdp.unsupportedReason = `Unsupported channel count: ${rtp.encoding}`;
      return sdp;
    }
  }

  sdp.isSupported = true;

  // Extract multicast address
  if (sdp.media[0]?.connection?.ip) {
    sdp.mcast = sdp.media[0].connection.ip.split('/')[0];
  } else if (sdp.connection?.ip) {
    sdp.mcast = sdp.connection.ip.split('/')[0];
  } else {
    sdp.mcast = null;
    sdp.isSupported = false;
    sdp.unsupportedReason = 'No multicast address';
  }

  // Extract audio parameters
  if (sdp.isSupported) {
    const media = sdp.media[0];
    const rtp = media.rtp[0];
    
    sdp.codec = rtp.codec;
    sdp.sampleRate = rtp.rate;
    sdp.channels = rtp.encoding;
    sdp.port = media.port;
    sdp.ptime = media.ptime || 1; // Default 1ms for AES67
    sdp.rtpMap = `${rtp.codec}/${rtp.rate}/${rtp.encoding}`;
  }

  // Check for Dante streams
  sdp.dante = sdp.keywords === 'Dante';
  
  // Description fallback
  sdp.description = sdp.description || sdp.media[0]?.description || '';

  // Extract device info from origin
  if (sdp.origin) {
    sdp.deviceIp = sdp.origin.address;
    sdp.sessionId = sdp.origin.sessionId;
    sdp.sessionVersion = sdp.origin.sessionVersion;
  }

  // Extract PTP clock reference from raw SDP (sdp-transform doesn't parse ts-refclk)
  if (sdp.raw) {
    // Parse a=ts-refclk:ptp=IEEE1588-2008:00-11-22-FF-FE-33-44-55:0
    const tsRefclkMatch = sdp.raw.match(/a=ts-refclk:ptp=(IEEE1588-\d+):([0-9A-Fa-f-]+):?(\d*)/i);
    if (tsRefclkMatch) {
      sdp.ptpVersion = tsRefclkMatch[1];
      sdp.ptpGrandmaster = tsRefclkMatch[2].toUpperCase();
      sdp.ptpDomain = tsRefclkMatch[3] || '0';
    } else {
      // Check for other clock reference formats
      const clockMatch = sdp.raw.match(/a=ts-refclk:(.+)/i);
      if (clockMatch) {
        console.log(`[SDP] Clock ref found (non-PTP): ${clockMatch[1]}`);
        sdp.clockRef = clockMatch[1].trim();
      }
    }

    // Parse a=mediaclk:direct=0
    const mediaclkMatch = sdp.raw.match(/a=mediaclk:(.+)/);
    if (mediaclkMatch) {
      sdp.mediaclk = mediaclkMatch[1].trim();
    }

    // Parse a=tool:SomeSoftware
    const toolMatch = sdp.raw.match(/a=tool:(.+)/);
    if (toolMatch) {
      sdp.tool = toolMatch[1].trim();
    }
  }

  const media = sdp.media[0];
  if (media) {
    // Check for redundancy (ST2022-7)
    if (sdp.groups) {
      const dupGroup = sdp.groups.find(g => g.type === 'DUP');
      if (dupGroup) {
        sdp.redundant = true;
        sdp.redundantMids = dupGroup.mids;
      }
    }

    // Extract mid for redundant streams
    sdp.mid = media.mid;
  }

  // Extract information line (channel names)
  sdp.info = sdp.description || null;

  return sdp;
}

/**
 * Handle incoming SAP message
 */
function handleSapMessage(message, rinfo) {
  // Validate SAP header
  if (message.length <= 24) return;
  
  const contentType = message.toString('ascii', 8, 23);
  if (contentType !== 'application/sdp') return;

  // Parse SDP payload
  const rawSdp = message.toString('utf8', 24);
  let sdp;
  
  try {
    sdp = sdpTransform.parse(rawSdp);
  } catch (e) {
    console.error('[SDP] Parse error:', e.message);
    return;
  }

  if (!sdp.origin || !sdp.name) return;

  // Check delete flag (bit 2 of first byte)
  const isDelete = (message.readUInt8(0) & 0x04) === 0x04;
  
  // Generate unique ID from origin
  const id = crypto
    .createHash('md5')
    .update(JSON.stringify(sdp.origin))
    .digest('hex');

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
  sdp.sapSourceIp = rinfo?.address || null; // IP that sent the SAP packet

  sessions[id] = parseSdp(sdp);

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
 */
function addManualStream(rawSdp) {
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

  // Don't overwrite existing SAP-announced stream
  if (sessions[id]) {
    sessions[id].lastSeen = Date.now();
    return;
  }

  sdp.raw = rawSdp;
  sdp.id = id;
  sdp.lastSeen = Date.now();
  sdp.manual = false;
  sdp.sourceType = 'sap';
  sdp.sapSourceIp = sourceIp || null;

  sessions[id] = parseSdp(sdp);
  const s = sessions[id];
  console.log(`[SDP] RAVENNA stream via RTSP: ${s.name} (${s.mcast}:${s.port})`);
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
 * Initialize socket and join multicast
 */
function init(address) {
  if (socket) {
    try {
      socket.dropMembership(SAP_MULTICAST, currentInterface);
    } catch (e) { /* ignore */ }
    socket.close();
  }

  currentInterface = address;
  socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', (err) => {
    console.error('[SDP Socket Error]', err.message);
    
    // Detect specific error types
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
      process.send({ 
        type: 'port-conflict', 
        port: SAP_PORT,
        code: err.code,
        message: `Port ${SAP_PORT} is already in use or access denied. Another application may be using this port.`
      });
    } else {
      process.send({ type: 'error', message: err.message });
    }
  });

  socket.on('message', handleSapMessage);

  socket.on('listening', () => {
    try {
      socket.setMulticastInterface(address);
      socket.addMembership(SAP_MULTICAST, address);
      console.log(`[SDP] Listening on ${address}`);
      process.send({ type: 'status', status: 'connected', port: SAP_PORT });
    } catch (e) {
      console.error('[SDP] Multicast join error:', e.message);
      process.send({ type: 'error', message: `Multicast join failed: ${e.message}` });
    }
  });

  socket.bind({ port: SAP_PORT, address: address, exclusive: false }, () => {
    console.log(`[SDP] Socket bound to ${address}:${SAP_PORT}`);
  });
}

/**
 * Change network interface
 */
function setInterface(address) {
  if (currentInterface === address) return;

  try {
    if (socket && currentInterface) {
      socket.dropMembership(SAP_MULTICAST, currentInterface);
    }
  } catch (e) { /* ignore */ }

  currentInterface = address;

  // Clear non-manual sessions
  for (const id of Object.keys(sessions)) {
    if (!sessions[id].manual) {
      delete sessions[id];
    }
  }

  try {
    if (socket) {
      socket.setMulticastInterface(address);
      socket.addMembership(SAP_MULTICAST, address);
    }
  } catch (e) {
    console.error('[SDP] Interface change error:', e.message);
    process.send({ type: 'error', message: e.message });
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

// Periodic update (prune + refresh)
setInterval(sendUpdate, 30000);

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
  if (socket) socket.close();
  process.exit(0);
});
