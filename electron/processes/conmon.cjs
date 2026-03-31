/**
 * Dante Conmon (Control & Monitoring) Child Process
 *
 * Listens passively on two Dante multicast groups:
 *   224.0.0.231:8702  — device notifications (AES67 mode, PTP clock status, make/model)
 *   224.0.0.233:8708  — heartbeat (clock lock state, device online/offline)
 *
 * Opcodes handled (from netaudio v0.2.4 / notification.py):
 *   0x0020  CONMON_OPCODE_PTP_CLOCK_STATUS   → preferredLeader (offset 0x26), ptpV1Role (offset 0x48)
 *   0x1007  CONMON_OPCODE_AES67_CURRENT_NEW  → aes67Current + aes67Configured (offset 0x21)
 *   0x00C0  CONMON_OPCODE_MAKE_MODEL         → manufacturer, productName, productVersion
 *   heartbeat subblock 0x8002               → clockLocked
 *
 * Emits IPC messages to main:
 *   { type: 'conmon-patch', ip, patch }  — device field updates to merge into registry
 *   { type: 'conmon-offline', ip }       — device has gone offline (no heartbeat for 15s)
 */

'use strict';

const dgram = require('dgram');

// ─── Protocol constants (from netaudio const.py + notification.py) ────────────

const MULTICAST_CONMON     = '224.0.0.231';
const MULTICAST_HEARTBEAT  = '224.0.0.233';
const PORT_CONMON          = 8702;
const PORT_HEARTBEAT       = 8708;

// Conmon packet: opcode extracted at (find("Audinate", 4) + 10) as uint16BE
const MAGIC = Buffer.from('Audinate');

// Conmon opcodes
const OPCODE_PTP_CLOCK_STATUS  = 0x0020;
const OPCODE_AES67_CURRENT_NEW = 0x1007;
const OPCODE_MAKE_MODEL        = 0x00C0;
const OPCODE_DANTE_MODEL       = 0x0060;

// Offsets within PTP clock status packet (0x0020)
const PREFERRED_LEADER_OFFSET  = 0x26; // uint8: non-zero = preferred leader
const PTP_V1_ROLE_OFFSET       = 0x48; // uint16BE: 0x0006=Leader, 0x0009=Follower
const PTP_V1_ROLE_LEADER       = 0x0006;
const PTP_V1_ROLE_FOLLOWER     = 0x0009;

// Offset within AES67 state packet (0x1007)
const AES67_STATE_OFFSET       = 0x21; // uint8: bits: current(bit0) + configured(bit1)

// Offsets within make/model packet (0x00C0)
const MANUFACTURER_OFFSET      = 0x4C;
const MANUFACTURER_END         = 0xCC;
const PRODUCT_NAME_OFFSET      = 0xCC;
const PRODUCT_NAME_END         = 0x14C;
const PRODUCT_VERSION_OFFSET   = 0x14C;
const PRODUCT_VERSION_END      = 0x150;

// Heartbeat: lock status subblock
const HEARTBEAT_HEADER_SIZE    = 0x20;
const SUBBLOCK_HEADER_SIZE     = 4;
const SUBBLOCK_LOCK_STATUS     = 0x8002;
const LOCK_STATE_OFFSET        = 16;   // within subblock
const LOCK_STATE_LOCKED        = 0x0001;
const LOCK_STATE_UNLOCKED      = 0x0002;

// Offline threshold: device not seen for 15s → mark offline
const OFFLINE_THRESHOLD_MS     = 15000;
const SWEEP_INTERVAL_MS        = 5000;

// ─── State ────────────────────────────────────────────────────────────────────

let currentInterface = null;
let conmonSocket     = null;
let heartbeatSocket  = null;
let sweepTimer       = null;

// IP → last heartbeat timestamp (ms)
const lastSeen = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract null-terminated UTF-8 string from buffer[start:end].
 * Skips leading non-printable bytes.
 */
function extractString(buf, start, end) {
  if (!buf || buf.length < end) return null;
  try {
    let raw = buf.slice(start, end);
    const nullPos = raw.indexOf(0);
    if (nullPos >= 0) raw = raw.slice(0, nullPos);
    // Skip leading non-printable
    let i = 0;
    while (i < raw.length && raw[i] < 0x20) i++;
    raw = raw.slice(i);
    if (!raw.length) return null;
    const text = raw.toString('utf8').trim();
    return text && [...text].every(c => c.charCodeAt(0) >= 0x20) ? text : null;
  } catch (_) {
    return null;
  }
}

/**
 * Extract conmon opcode from packet.
 * Layout: find "Audinate" magic at offset >4, opcode is at magic+10 (uint16BE).
 */
function extractOpcode(data) {
  if (data.length < 0x20) return null;
  try {
    const magicPos = data.indexOf(MAGIC, 4);
    if (magicPos < 0) return null;
    const opcodePos = magicPos + 10;
    if (opcodePos + 2 > data.length) return null;
    return data.readUInt16BE(opcodePos);
  } catch (_) {
    return null;
  }
}

// ─── Packet parsers ───────────────────────────────────────────────────────────

/**
 * Parse PTP clock status packet (opcode 0x0020).
 * Returns patch fields for NetworkDevice.
 */
function parsePtpClockStatus(data) {
  const patch = {};
  if (data.length > PREFERRED_LEADER_OFFSET) {
    patch.preferredLeader = data[PREFERRED_LEADER_OFFSET] !== 0;
  }
  if (data.length > PTP_V1_ROLE_OFFSET + 1) {
    const role = data.readUInt16BE(PTP_V1_ROLE_OFFSET);
    if (role === PTP_V1_ROLE_LEADER)   patch.ptpV1Role = 'Leader';
    else if (role === PTP_V1_ROLE_FOLLOWER) patch.ptpV1Role = 'Follower';
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Parse AES67 current/new state packet (opcode 0x1007).
 */
function parseAes67State(data) {
  if (data.length <= AES67_STATE_OFFSET) return null;
  const byte = data[AES67_STATE_OFFSET];
  // bit 0 = current, bit 1 = configured
  return {
    aes67Current:    (byte & 0x01) !== 0,
    aes67Configured: (byte & 0x02) !== 0,
  };
}

/**
 * Parse make/model response packet (opcode 0x00C0).
 */
function parseMakeModel(data) {
  const patch = {};
  const manufacturer = extractString(data, MANUFACTURER_OFFSET, MANUFACTURER_END);
  if (manufacturer) patch.manufacturer = manufacturer;

  const productName = extractString(data, PRODUCT_NAME_OFFSET, PRODUCT_NAME_END);
  if (productName) patch.productName = productName;

  if (data.length >= PRODUCT_VERSION_END) {
    try {
      const [major, minor, , build] = data.slice(PRODUCT_VERSION_OFFSET, PRODUCT_VERSION_END);
      if (major || minor || build) {
        patch.productVersion = `${major}.${minor}.${build}`;
      }
    } catch (_) {}
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Parse heartbeat lock state.
 * Returns true=locked, false=unlocked, null=unknown.
 */
function parseHeartbeatLock(data) {
  let offset = HEARTBEAT_HEADER_SIZE;
  while (offset + SUBBLOCK_HEADER_SIZE <= data.length) {
    const blockSize  = data.readUInt16BE(offset);
    if (blockSize < SUBBLOCK_HEADER_SIZE || offset + blockSize > data.length) break;
    const subOpcode  = data.readUInt16BE(offset + 2);
    if (subOpcode === SUBBLOCK_LOCK_STATUS) {
      if (offset + LOCK_STATE_OFFSET + 2 <= data.length) {
        const lockValue = data.readUInt16BE(offset + LOCK_STATE_OFFSET);
        if (lockValue === LOCK_STATE_LOCKED)   return true;
        if (lockValue === LOCK_STATE_UNLOCKED) return false;
      }
      return null;
    }
    offset += blockSize;
  }
  return null;
}

// ─── Socket management ────────────────────────────────────────────────────────

function createMulticastSocket(group, port, onMessage) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('error', (err) => {
    console.error(`[Conmon] Socket error ${group}:${port}: ${err.message}`);
  });

  sock.on('message', (data, rinfo) => {
    onMessage(data, rinfo.address);
  });

  sock.bind(port, () => {
    try {
      if (currentInterface) {
        sock.setMulticastInterface(currentInterface);
      }
      sock.addMembership(group, currentInterface || '0.0.0.0');
      console.log(`[Conmon] Joined ${group}:${port} on ${currentInterface || '0.0.0.0'}`);
    } catch (e) {
      console.error(`[Conmon] Multicast join error ${group}: ${e.message}`);
    }
  });

  return sock;
}

function handleConmonPacket(data, sourceIp) {
  const opcode = extractOpcode(data);
  if (opcode === null) return;

  let patch = null;

  switch (opcode) {
    case OPCODE_PTP_CLOCK_STATUS:
      patch = parsePtpClockStatus(data);
      break;
    case OPCODE_AES67_CURRENT_NEW:
      patch = parseAes67State(data);
      break;
    case OPCODE_MAKE_MODEL:
      patch = parseMakeModel(data);
      break;
    default:
      return; // ignore unknown opcodes
  }

  if (patch && Object.keys(patch).length > 0) {
    process.send({ type: 'conmon-patch', ip: sourceIp, patch });
  }
}

function handleHeartbeatPacket(data, sourceIp) {
  lastSeen.set(sourceIp, Date.now());
  const locked = parseHeartbeatLock(data);
  if (locked !== null) {
    process.send({ type: 'conmon-patch', ip: sourceIp, patch: { clockLocked: locked } });
  }
}

function startSockets() {
  conmonSocket    = createMulticastSocket(MULTICAST_CONMON,    PORT_CONMON,    handleConmonPacket);
  heartbeatSocket = createMulticastSocket(MULTICAST_HEARTBEAT, PORT_HEARTBEAT, handleHeartbeatPacket);
}

function stopSockets() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  try { if (conmonSocket)    { conmonSocket.close();    conmonSocket    = null; } } catch (_) {}
  try { if (heartbeatSocket) { heartbeatSocket.close(); heartbeatSocket = null; } } catch (_) {}
  lastSeen.clear();
}

function startSweep() {
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, ts] of lastSeen) {
      if (now - ts > OFFLINE_THRESHOLD_MS) {
        console.log(`[Conmon] Device offline (no heartbeat): ${ip}`);
        process.send({ type: 'conmon-offline', ip });
        lastSeen.delete(ip);
      }
    }
  }, SWEEP_INTERVAL_MS);
}

function init(interfaceIp) {
  stopSockets();
  if (interfaceIp) currentInterface = interfaceIp;
  startSockets();
  startSweep();
  console.log(`[Conmon] Started on interface ${currentInterface || 'any'}`);
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

process.on('message', (msg) => {
  switch (msg.type) {
    case 'start':
      init(msg.interface || null);
      break;
    case 'set-interface':
      stopSockets();
      currentInterface = msg.address || null;
      startSockets();
      startSweep();
      break;
    case 'stop':
      stopSockets();
      break;
  }
});

process.on('disconnect', () => {
  stopSockets();
  process.exit(0);
});
