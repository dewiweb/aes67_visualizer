/**
 * PTP IEEE 1588 Protocol Parser
 *
 * Listens directly on UDP ports 319 (event) and 320 (general) for PTP packets.
 * Parses Announce, Sync, Follow_Up, Delay_Resp messages.
 *
 * Based on:
 *   - IEEE 1588-2008 / 1588-2019 specification
 *   - soundondigital/ravennakit ptp_definitions.hpp, ptp_message_header.hpp, ptp_announce_message.hpp
 *   - martim01/pam ptpmonkey library
 *
 * PTP message header layout (34 bytes, big-endian):
 *   offset  0: transportSpecific(4) | messageType(4)
 *   offset  1: reserved(4) | versionPTP(4)
 *   offset  2: messageLength (2 bytes)
 *   offset  4: domainNumber (1 byte)
 *   offset  5: sdoIdMinor (1 byte)
 *   offset  6: flagField (2 bytes)
 *   offset  8: correctionField (8 bytes, nanoseconds * 2^16)
 *   offset 16: messageTypeSpecific (4 bytes)
 *   offset 20: sourcePortIdentity: clockIdentity(8) + portNumber(2) = 10 bytes
 *   offset 30: sequenceId (2 bytes)
 *   offset 32: controlField (1 byte)
 *   offset 33: logMessageInterval (1 byte)
 *
 * Announce body (after 34-byte header, 30 bytes):
 *   offset 34: originTimestamp (10 bytes)
 *   offset 44: currentUtcOffset (2 bytes, signed)
 *   offset 46: reserved (1 byte)
 *   offset 47: grandmasterPriority1 (1 byte)
 *   offset 48: grandmasterClockQuality (4 bytes: clockClass, clockAccuracy, offsetScaledLogVariance)
 *   offset 52: grandmasterPriority2 (1 byte)
 *   offset 53: grandmasterIdentity (8 bytes)
 *   offset 61: stepsRemoved (2 bytes)
 *   offset 63: timeSource (1 byte)
 */

'use strict';

const dgram = require('dgram');

// PTP UDP ports
const PORT_EVENT   = 319;  // Sync, Delay_Req, Pdelay_*
const PORT_GENERAL = 320;  // Announce, Follow_Up, Delay_Resp, Management

// PTP multicast addresses (IEEE 1588-2008)
const MCAST_PRIMARY = '224.0.1.129';  // Default E2E multicast
const MCAST_PDELAY  = '224.0.0.107';  // P2P pdelay multicast

// Message types (IEEE 1588-2019, Table 36)
const MSG_SYNC             = 0x0;
const MSG_DELAY_REQ        = 0x1;
const MSG_PDELAY_REQ       = 0x2;
const MSG_PDELAY_RESP      = 0x3;
const MSG_FOLLOW_UP        = 0x8;
const MSG_DELAY_RESP       = 0x9;
const MSG_PDELAY_RESP_FUP  = 0xa;
const MSG_ANNOUNCE         = 0xb;
const MSG_SIGNALING        = 0xc;
const MSG_MANAGEMENT       = 0xd;

const MSG_NAMES = {
  [MSG_SYNC]:            'Sync',
  [MSG_DELAY_REQ]:       'Delay_Req',
  [MSG_PDELAY_REQ]:      'Pdelay_Req',
  [MSG_PDELAY_RESP]:     'Pdelay_Resp',
  [MSG_FOLLOW_UP]:       'Follow_Up',
  [MSG_DELAY_RESP]:      'Delay_Resp',
  [MSG_PDELAY_RESP_FUP]: 'Pdelay_Resp_Follow_Up',
  [MSG_ANNOUNCE]:        'Announce',
  [MSG_SIGNALING]:       'Signaling',
  [MSG_MANAGEMENT]:      'Management',
};

// Clock accuracy codes (IEEE 1588-2019, Table 4)
const CLOCK_ACCURACY = {
  0x17: '< 1ps', 0x18: '< 2.5ps', 0x19: '< 10ps', 0x1a: '< 25ps',
  0x1b: '< 100ps', 0x1c: '< 250ps', 0x1d: '< 1ns', 0x1e: '< 2.5ns',
  0x1f: '< 10ns', 0x20: '< 25ns', 0x21: '< 100ns', 0x22: '< 250ns',
  0x23: '< 1µs', 0x24: '< 2.5µs', 0x25: '< 10µs', 0x26: '< 25µs',
  0x27: '< 100µs', 0x28: '< 250µs', 0x29: '< 1ms', 0x2a: '< 2.5ms',
  0x2b: '< 10ms', 0x2c: '< 25ms', 0x2d: '< 100ms', 0x2e: '< 250ms',
  0x2f: '< 1s', 0x30: '< 10s', 0x31: '> 10s', 0xfe: 'unknown',
};

// Time source codes (IEEE 1588-2019, Table 6)
const TIME_SOURCE = {
  0x10: 'ATOMIC_CLOCK', 0x20: 'GNSS', 0x30: 'TERRESTRIAL_RADIO',
  0x39: 'SERIAL_TIME_CODE', 0x40: 'PTP', 0x50: 'NTP',
  0x60: 'HAND_SET', 0x90: 'OTHER', 0xa0: 'INTERNAL_OSCILLATOR',
};

// ── Packet parsers ────────────────────────────────────────────────────────────

/**
 * Parse the 34-byte PTP common header.
 * Returns null if buffer is too short or version is not 2.
 */
function parseHeader(buf) {
  if (buf.length < 34) return null;

  const byte0       = buf.readUInt8(0);
  const messageType = byte0 & 0x0f;
  const byte1       = buf.readUInt8(1);
  const version     = byte1 & 0x0f;

  if (version !== 2) return null; // Only PTPv2

  const messageLength = buf.readUInt16BE(2);
  const domainNumber  = buf.readUInt8(4);
  const flagField     = buf.readUInt16BE(6);

  // Correction field: signed 64-bit, nanoseconds × 2^16
  // We read as two 32-bit halves to avoid BigInt complications
  const corrHi = buf.readInt32BE(8);
  const corrLo = buf.readUInt32BE(12);
  const correctionNs = (corrHi * 0x100000000 + corrLo) / 65536;

  // Clock identity: 8 bytes as EUI-64 formatted string XX-XX-XX-XX-XX-XX-XX-XX
  const ci = buf.slice(20, 28);
  const clockIdentity = Array.from(ci).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('-');

  const portNumber = buf.readUInt16BE(28);
  const sequenceId = buf.readUInt16BE(30);
  const logMessageInterval = buf.readInt8(33);

  // Flag bits
  const twoStep         = (flagField & 0x0200) !== 0;
  const unicast         = (flagField & 0x0400) !== 0;
  const ptpTimescale    = (flagField & 0x0008) !== 0;
  const timeTraceable   = (flagField & 0x0010) !== 0;
  const freqTraceable   = (flagField & 0x0020) !== 0;

  return {
    messageType, version, messageLength, domainNumber,
    correctionNs, clockIdentity, portNumber, sequenceId,
    logMessageInterval, twoStep, unicast, ptpTimescale,
    timeTraceable, freqTraceable,
    messageName: MSG_NAMES[messageType] || `0x${messageType.toString(16)}`,
  };
}

/**
 * Parse PTP Announce message body (after 34-byte header).
 * Returns grandmaster info.
 */
function parseAnnounce(buf, header) {
  if (buf.length < 64) return null; // 34 header + 30 body

  // currentUtcOffset at offset 44 (after 10-byte originTimestamp)
  const currentUtcOffset = buf.readInt16BE(44);

  const gmPriority1 = buf.readUInt8(47);
  const gmClockClass    = buf.readUInt8(48);
  const gmClockAccuracy = buf.readUInt8(49);
  const gmOffsetScaledLogVariance = buf.readUInt16BE(50);
  const gmPriority2 = buf.readUInt8(52);

  // grandmasterIdentity: 8 bytes at offset 53
  const gm = buf.slice(53, 61);
  const grandmasterIdentity = Array.from(gm)
    .map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('-');

  const stepsRemoved = buf.readUInt16BE(61);
  const timeSource   = buf.readUInt8(63);

  return {
    ...header,
    grandmasterIdentity,
    grandmasterPriority1: gmPriority1,
    grandmasterPriority2: gmPriority2,
    clockClass:    gmClockClass,
    clockAccuracy: CLOCK_ACCURACY[gmClockAccuracy] || `0x${gmClockAccuracy.toString(16)}`,
    clockAccuracyCode: gmClockAccuracy,
    offsetScaledLogVariance: gmOffsetScaledLogVariance,
    stepsRemoved,
    timeSource: TIME_SOURCE[timeSource] || `0x${timeSource.toString(16)}`,
    timeSourceCode: timeSource,
    currentUtcOffset,
  };
}

/**
 * Parse a PTP Sync or Follow_Up timestamp (10 bytes at offset 34).
 * Returns seconds (float).
 */
function parseTimestamp(buf, offset) {
  if (buf.length < offset + 10) return null;
  // 6-byte seconds (we read as 2+4)
  const secHi = buf.readUInt16BE(offset);
  const secLo = buf.readUInt32BE(offset + 2);
  const nsec  = buf.readUInt32BE(offset + 6);
  return secHi * 0x100000000 + secLo + nsec / 1e9;
}

// ── Clock registry ────────────────────────────────────────────────────────────

/**
 * Track all PTP clocks observed on the network.
 * Key: clockIdentity  Value: clock state object
 */
const clocks = new Map();

// Pending two-step Sync messages waiting for Follow_Up: sequenceId → { header, t1walltime }
const pendingSyncs = new Map();

function formatClockId(id) {
  // Convert XX-XX-XX-FF-FE-XX-XX-XX to MAC-like display
  const parts = id.split('-');
  if (parts.length === 8) {
    return `${parts[0]}:${parts[1]}:${parts[2]}:${parts[5]}:${parts[6]}:${parts[7]}`;
  }
  return id;
}

function getOrCreate(clockIdentity, domainNumber) {
  const key = `${clockIdentity}@${domainNumber}`;
  if (!clocks.has(key)) {
    clocks.set(key, {
      clockIdentity,
      domainNumber,
      isGrandmaster: false,
      lastSeen: Date.now(),
      announceCount: 0,
      syncCount: 0,
    });
  }
  return clocks.get(key);
}

// ── Offset measurement ────────────────────────────────────────────────────────

// Per-clock offset history for mean/stddev (rolling 20 samples)
const offsetHistory = new Map();

function addOffsetSample(clockKey, offsetUs) {
  if (!offsetHistory.has(clockKey)) offsetHistory.set(clockKey, []);
  const hist = offsetHistory.get(clockKey);
  hist.push(offsetUs);
  if (hist.length > 20) hist.shift();
}

function getOffsetStats(clockKey) {
  const hist = offsetHistory.get(clockKey);
  if (!hist || hist.length < 2) return null;
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  const variance = hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length;
  const stddev = Math.sqrt(variance);
  const min = Math.min(...hist);
  const max = Math.max(...hist);
  return { mean, stddev, min, max, samples: hist.length };
}

// ── Main packet handler ───────────────────────────────────────────────────────

function handlePacket(buf, rinfo) {
  const header = parseHeader(buf);
  if (!header) return;

  const { messageType, clockIdentity, domainNumber, sequenceId } = header;
  const clockKey = `${clockIdentity}@${domainNumber}`;

  const clock = getOrCreate(clockIdentity, domainNumber);
  clock.lastSeen = Date.now();

  switch (messageType) {
    case MSG_ANNOUNCE: {
      const announce = parseAnnounce(buf, header);
      if (!announce) break;

      clock.announceCount++;
      clock.grandmasterIdentity    = announce.grandmasterIdentity;
      clock.grandmasterPriority1   = announce.grandmasterPriority1;
      clock.grandmasterPriority2   = announce.grandmasterPriority2;
      clock.clockClass             = announce.clockClass;
      clock.clockAccuracy          = announce.clockAccuracy;
      clock.offsetScaledLogVariance = announce.offsetScaledLogVariance;
      clock.stepsRemoved           = announce.stepsRemoved;
      clock.timeSource             = announce.timeSource;
      clock.currentUtcOffset       = announce.currentUtcOffset;
      clock.logAnnounceInterval    = announce.logMessageInterval;
      clock.domainNumber           = domainNumber;

      // A clock is grandmaster if its clockIdentity == grandmasterIdentity
      clock.isGrandmaster = (clockIdentity === announce.grandmasterIdentity);

      // Mark other clocks in this domain that are no longer grandmaster
      for (const [key, c] of clocks) {
        if (c.domainNumber === domainNumber && key !== clockKey) {
          if (c.isGrandmaster && clock.isGrandmaster) {
            c.isGrandmaster = false;
          }
        }
      }

      emitUpdate();
      break;
    }

    case MSG_SYNC: {
      clock.syncCount++;
      clock.logSyncInterval = header.logMessageInterval;

      if (!header.twoStep) {
        // One-step: timestamp is in the sync packet itself
        const t1 = parseTimestamp(buf, 34);
        if (t1 !== null) clock.lastSyncTimestamp = t1;
      } else {
        // Two-step: record wall-clock time of receipt, wait for Follow_Up
        pendingSyncs.set(`${clockKey}:${sequenceId}`, {
          header,
          t2wall: Date.now() / 1000,
        });
        // Prune old pending syncs (> 5s old)
        const now = Date.now() / 1000;
        for (const [k, v] of pendingSyncs) {
          if (now - v.t2wall > 5) pendingSyncs.delete(k);
        }
      }
      break;
    }

    case MSG_FOLLOW_UP: {
      // t1 is the precise Sync origin timestamp from the master
      const pending = pendingSyncs.get(`${clockKey}:${sequenceId}`);
      if (!pending) break;
      pendingSyncs.delete(`${clockKey}:${sequenceId}`);

      const t1 = parseTimestamp(buf, 34);
      if (t1 === null) break;

      // Rough offset estimate: t2(wall) - t1(master) in microseconds
      // Note: this is not accurate without hardware timestamps — it's indicative only
      const offsetUs = (pending.t2wall - t1) * 1e6;

      // Only record if plausible (< 1 second, avoids startup noise)
      if (Math.abs(offsetUs) < 1e6) {
        addOffsetSample(clockKey, offsetUs);
        const stats = getOffsetStats(clockKey);
        if (stats) {
          clock.offsetMeanUs  = Math.round(stats.mean * 100) / 100;
          clock.offsetStddevUs = Math.round(stats.stddev * 100) / 100;
          clock.offsetMinUs   = Math.round(stats.min * 100) / 100;
          clock.offsetMaxUs   = Math.round(stats.max * 100) / 100;
          clock.offsetSamples = stats.samples;
        }
        emitUpdate();
      }
      break;
    }

    case MSG_DELAY_RESP: {
      // Could compute path delay here in future
      break;
    }
  }
}

// ── Output ────────────────────────────────────────────────────────────────────

let emitTimer = null;

function emitUpdate() {
  clearTimeout(emitTimer);
  emitTimer = setTimeout(() => {
    const list = [];
    for (const [key, clock] of clocks) {
      // Prune clocks not seen for > 30s (missed 3+ announce intervals)
      if (Date.now() - clock.lastSeen > 30000) {
        clocks.delete(key);
        continue;
      }
      list.push({
        clockIdentity:        clock.clockIdentity,
        displayId:            formatClockId(clock.clockIdentity),
        domainNumber:         clock.domainNumber,
        isGrandmaster:        clock.isGrandmaster,
        grandmasterIdentity:  clock.grandmasterIdentity || null,
        grandmasterDisplayId: clock.grandmasterIdentity ? formatClockId(clock.grandmasterIdentity) : null,
        priority1:            clock.grandmasterPriority1 ?? null,
        priority2:            clock.grandmasterPriority2 ?? null,
        clockClass:           clock.clockClass ?? null,
        clockAccuracy:        clock.clockAccuracy || null,
        timeSource:           clock.timeSource || null,
        stepsRemoved:         clock.stepsRemoved ?? null,
        currentUtcOffset:     clock.currentUtcOffset ?? null,
        logSyncInterval:      clock.logSyncInterval ?? null,
        logAnnounceInterval:  clock.logAnnounceInterval ?? null,
        offsetMeanUs:         clock.offsetMeanUs ?? null,
        offsetStddevUs:       clock.offsetStddevUs ?? null,
        offsetSamples:        clock.offsetSamples ?? 0,
        lastSeen:             clock.lastSeen,
        announceCount:        clock.announceCount,
        syncCount:            clock.syncCount,
      });
    }

    // Sort: grandmasters first, then by domain, then by clockIdentity
    list.sort((a, b) => {
      if (a.isGrandmaster !== b.isGrandmaster) return a.isGrandmaster ? -1 : 1;
      if (a.domainNumber !== b.domainNumber) return a.domainNumber - b.domainNumber;
      return a.clockIdentity.localeCompare(b.clockIdentity);
    });

    process.send({ type: 'ptp-clocks', clocks: list });
  }, 200);
}

// ── Socket management ─────────────────────────────────────────────────────────

let sockEvent   = null;
let sockGeneral = null;
let currentInterface = null;

function bindSocket(port, onPacket, onError) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('error', (err) => {
    if (err.code === 'EACCES') {
      console.error(
        `[PTP] Permission denied on port ${port}. On Linux, run:\n` +
        `  sudo setcap cap_net_bind_service=+eip /path/to/aes67-visualizer.AppImage\n` +
        `  or: sudo sysctl -w net.ipv4.ip_unprivileged_port_start=319`
      );
    } else {
      console.error(`[PTP] Socket error port ${port}:`, err.message);
    }
    if (onError) onError(err);
  });

  sock.on('message', (buf, rinfo) => onPacket(buf, rinfo));

  sock.bind({ port, exclusive: false }, () => {
    try {
      sock.addMembership(MCAST_PRIMARY, currentInterface);
      console.log(`[PTP] Listening on port ${port} (${MCAST_PRIMARY}, iface=${currentInterface})`);
    } catch (e) {
      console.error(`[PTP] addMembership error port ${port}:`, e.message);
    }
    try {
      sock.addMembership(MCAST_PDELAY, currentInterface);
    } catch (_) {} // P2P pdelay optional
  });

  return sock;
}

function start(interfaceAddress) {
  stop();
  currentInterface = interfaceAddress;

  sockEvent   = bindSocket(PORT_EVENT,   handlePacket, null);
  sockGeneral = bindSocket(PORT_GENERAL, handlePacket, null);

  process.send({ type: 'ptp-status', status: 'listening', interface: interfaceAddress });
}

function stop() {
  if (sockEvent)   { try { sockEvent.close();   } catch (_) {} sockEvent   = null; }
  if (sockGeneral) { try { sockGeneral.close(); } catch (_) {} sockGeneral = null; }
  clocks.clear();
  pendingSyncs.clear();
  offsetHistory.clear();
}

function setInterface(address) {
  if (address === currentInterface) return;
  console.log(`[PTP] Interface changed: ${currentInterface} → ${address}`);
  start(address);
}

// ── IPC ───────────────────────────────────────────────────────────────────────

process.on('message', (msg) => {
  switch (msg.type) {
    case 'start':
      start(msg.interface);
      break;
    case 'stop':
      stop();
      break;
    case 'set-interface':
      setInterface(msg.address);
      break;
  }
});

process.on('disconnect', () => {
  stop();
  process.exit(0);
});
