/**
 * PTP IEEE 1588 Protocol Parser
 *
 * Supports PTPv1 (IEEE 1588-2002, used by Dante by default) and
 * PTPv2 (IEEE 1588-2008/2019, used by RAVENNA, AES67, and Dante in AES67 mode).
 *
 * Key protocol facts (from Audinate/Luminex documentation):
 *   - Dante devices use PTPv1 by default (domain 0, subdomain "DFLT")
 *   - Dante+AES67 devices run PTPv1 (Dante domain) AND PTPv2 (AES67 domain) simultaneously
 *   - The AES67-enabled Dante device acts as Boundary Clock bridging both PTP versions
 *   - RAVENNA and pure AES67 devices use PTPv2 only
 *   - PTPv1 and PTPv2 are NOT backwards compatible
 *
 * PTPv2 message header layout (34 bytes, big-endian):
 *   offset  0: transportSpecific(4) | messageType(4)
 *   offset  1: reserved(4) | versionPTP(4)  ← version = 0x02
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
 * PTPv2 Announce body (after 34-byte header):
 *   offset 34: originTimestamp (10 bytes)
 *   offset 44: currentUtcOffset (2 bytes, signed)
 *   offset 46: reserved (1 byte)
 *   offset 47: grandmasterPriority1 (1 byte)
 *   offset 48: grandmasterClockQuality (4 bytes: clockClass, clockAccuracy, offsetScaledLogVariance)
 *   offset 52: grandmasterPriority2 (1 byte)
 *   offset 53: grandmasterIdentity (8 bytes)
 *   offset 61: stepsRemoved (2 bytes)
 *   offset 63: timeSource (1 byte)
 *
 * PTPv1 header layout (40 bytes, big-endian):
 *   offset  0: versionPTP (1 byte) = 0x01
 *   offset  1: versionNetwork (1 byte) = 0x01
 *   offset  2: subdomain[16 bytes] — "\0\0\0\0" for Dante default domain
 *   offset 18: messageType (1 byte) — 1=Sync, 2=Delay_Req, 8=FollowUp, 9=DelayResp
 *   offset 19: sourceCommunicationTechnology (1 byte) — 1=UDP/IPv4
 *   offset 20: sourceUuid[6 bytes] — source MAC address (EUI-48)
 *   offset 26: sourcePortId (2 bytes)
 *   offset 28: sequenceId (2 bytes)
 *   offset 30: control (1 byte)
 *   offset 31: logMessagePeriod (1 byte)
 *
 * PTPv1 Sync body (after 40-byte header):
 *   offset 40: originTimestamp (8 bytes)
 *   offset 48: epochNumber (2 bytes)
 *   offset 50: currentUTCOffset (2 bytes)
 *   offset 52: grandmasterCommunicationTechnology (1 byte)
 *   offset 53: grandmasterClockUuid[6 bytes] — grandmaster MAC address
 *   offset 59: grandmasterPortId (2 bytes)
 *   offset 61: grandmasterSequenceId (2 bytes)
 *   offset 71: grandmasterClockStratum (1 byte) — clock quality (1=atomic, 4=OCXO, 8=free-running)
 *   offset 72: grandmasterClockIdentifier[4] — "\0\0\0\0" for Dante
 *   offset 76: grandmasterClockVariance (2 bytes)
 *   offset 78: grandmasterPreferred (1 byte) — 0x01 if preferred master
 *   offset 79: grandmasterIsBoundaryClock (1 byte) — 0x01 if BC
 *   offset 83: localStepsRemoved (2 bytes)
 *   offset 85: localClockStratum (1 byte)
 */

'use strict';

const dgram    = require('dgram');
const os       = require('os');
const IS_LINUX = os.platform() === 'linux';

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

  if (version !== 2) return null; // PTPv2 only — v1 handled by parseHeaderV1

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
 * Parse a PTPv1 (IEEE 1588-2002) packet header.
 * Returns null if buf is too short or version byte is not 1.
 * Note: PTPv1 header is 40 bytes (vs 34 for v2), and the sourceUuid is
 * a 6-byte EUI-48 MAC address at offset 20 (not an 8-byte EUI-64).
 */
function parseHeaderV1(buf) {
  if (buf.length < 40) return null;
  const version = buf.readUInt8(0);
  if (version !== 1) return null;

  // PTPv1: byte 1 = versionNetwork = 0x01
  // PTPv2: byte 1 = reserved(4)|versionPTP(4) = 0x02
  // A PTPv2 Delay_Req has byte 0 = 0x01 (messageType=1) → must reject via this check
  const versionNetwork = buf.readUInt8(1);
  if (versionNetwork !== 1) return null;

  const messageType = buf.readUInt8(18);
  const subdomain   = buf.toString('ascii', 2, 18).replace(/\0/g, '').trim();
  const uuid        = buf.slice(20, 26);
  // Build a pseudo EUI-64 clockIdentity from EUI-48 by inserting FF-FE
  // (same convention as IEEE 802.1AB / EUI-64 from EUI-48)
  const clockIdentity = [
    uuid[0], uuid[1], uuid[2], 0xff, 0xfe, uuid[3], uuid[4], uuid[5],
  ].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('-');

  const sequenceId = buf.readUInt16BE(28);
  const domainNumber = 0; // PTPv1 uses subdomain strings, map to domain 0

  return {
    version: 1,
    messageType,
    domainNumber,
    subdomain,
    clockIdentity,
    sequenceId,
    messageName: { 1: 'Sync', 2: 'Delay_Req', 8: 'Follow_Up', 9: 'Delay_Resp' }[messageType] || `v1:0x${messageType.toString(16)}`,
    ptpTimescale: false,
    timeTraceable: false,
    freqTraceable: false,
    twoStep: false,
    unicast: false,
  };
}

/**
 * Parse a PTPv1 Sync message body (starts at offset 40).
 * The Sync message in v1 carries GM information directly (no Announce message type).
 */
function parseV1SyncBody(buf, header) {
  if (buf.length < 92) return null;

  const gmUuid = buf.slice(53, 59);
  // Reconstruct EUI-64 for grandmaster from its EUI-48 MAC
  const grandmasterIdentity = [
    gmUuid[0], gmUuid[1], gmUuid[2], 0xff, 0xfe, gmUuid[3], gmUuid[4], gmUuid[5],
  ].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('-');

  const grandmasterClockStratum = buf.readUInt8(71);
  const grandmasterPreferred    = buf.readUInt8(78) === 1;
  const grandmasterIsBoundaryClock = buf.readUInt8(79) === 1;
  const currentUtcOffset        = buf.readInt16BE(50);
  const stepsRemoved            = buf.readUInt16BE(83);
  const localStratum            = buf.readUInt8(85);

  // PTPv1 stratum values: 1=atomic ref, 2=GPS, 3=radio, 4=OCXO, 5-7=crystal, 8=free-running
  const stratumLabel = {
    1: 'Atomic reference', 2: 'GPS/GNSS', 3: 'Terrestrial radio',
    4: 'OCXO', 5: 'Crystal osc.', 6: 'Crystal osc.', 7: 'Crystal osc.',
    8: 'Free-running',
  }[grandmasterClockStratum] || `Stratum ${grandmasterClockStratum}`;

  return {
    ...header,
    grandmasterIdentity,
    grandmasterIsBoundaryClock,
    grandmasterPreferred,
    grandmasterClockStratum,
    clockAccuracy: stratumLabel,
    clockAccuracyCode: grandmasterClockStratum,
    stepsRemoved,
    localStratum,
    currentUtcOffset,
    // PTPv1 has no clockClass/priority1/priority2 — use stratum as proxy
    grandmasterPriority1: null,
    grandmasterPriority2: null,
    clockClass: null,
    timeSource: 'INTERNAL_OSCILLATOR', // default for Dante v1
    timeSourceCode: 0xa0,
  };
}

/**
 * Deduce a PTP profile label from version, clock class and time source.
 * References:
 *   Dante (default):           PTPv1, stratum 8 (free-running crystal)
 *   Dante+AES67 bridge:        PTPv1 (Dante domain) + PTPv2 (AES67 domain)
 *   AES67-2018 §9.1:           clockClass=248, timeSource=INTERNAL_OSCILLATOR(0xa0)
 *   RAVENNA:                   clockClass=135 (slave-only) or 248
 *   SMPTE ST 2059:             clockClass=7-13, timeSource=GNSS(0x20)
 */
function detectProfile(version, clockClass, timeSourceCode) {
  if (version === 1) return 'Dante (PTPv1)';
  if (timeSourceCode === 0x20 || timeSourceCode === 0x10) return 'SMPTE ST2059 (GNSS/Atomic)';
  if (clockClass === 248 && timeSourceCode === 0xa0) return 'AES67';
  if (clockClass === 135) return 'Dante/RAVENNA (AES67 mode)';
  if (clockClass >= 1 && clockClass <= 13) return 'Primary reference (GNSS)';
  if (clockClass === 248) return 'AES67/RAVENNA';
  return null;
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
      ptpVersion: null,
      ptpProfile: null,
      clockRole: null,
      ptpTimescale: null,
      timeTraceable: null,
      freqTraceable: null,
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

// ── PTPv1 packet handler ──────────────────────────────────────────────────────

function handlePacketV1(buf, header, rinfo) {
  const { clockIdentity, domainNumber, messageType } = header;

  // PTPv1 Sync (type 1) carries full GM info — equivalent of v2 Announce
  if (messageType !== 1) return; // only process Sync for now

  const syncInfo = parseV1SyncBody(buf, header);
  if (!syncInfo) return;

  const clockKey = `${clockIdentity}@${domainNumber}`;
  const clock = getOrCreate(clockIdentity, domainNumber);
  clock.lastSeen = Date.now();
  clock.announceCount++; // treat v1 Sync as announce equivalent

  clock.grandmasterIdentity        = syncInfo.grandmasterIdentity;
  clock.grandmasterPriority1       = null;
  clock.grandmasterPriority2       = null;
  clock.clockClass                 = null;
  clock.clockAccuracy              = syncInfo.clockAccuracy;
  clock.stepsRemoved               = syncInfo.stepsRemoved;
  clock.timeSource                 = syncInfo.timeSource;
  clock.timeSourceCode             = syncInfo.timeSourceCode;
  clock.currentUtcOffset           = syncInfo.currentUtcOffset;
  clock.grandmasterClockStratum    = syncInfo.grandmasterClockStratum;
  clock.grandmasterPreferred       = syncInfo.grandmasterPreferred;
  clock.grandmasterIsBoundaryClock = syncInfo.grandmasterIsBoundaryClock;
  clock.ptpVersion                 = 1;
  clock.ptpTimescale               = false;
  clock.timeTraceable              = false;
  clock.freqTraceable              = false;
  clock.ptpProfile                 = 'Dante (PTPv1)';

  clock.isGrandmaster = (clockIdentity === syncInfo.grandmasterIdentity);

  // Mark other clocks in this domain that are no longer grandmaster
  for (const [key, c] of clocks) {
    if (c.domainNumber === domainNumber && key !== clockKey) {
      if (c.isGrandmaster && clock.isGrandmaster) c.isGrandmaster = false;
    }
  }

  // PTPv1 BC flag is explicit — override heuristic
  if (syncInfo.grandmasterIsBoundaryClock) {
    clock.clockRole = 'boundary';
  }

  emitUpdate();
}

// ── Main packet handler ───────────────────────────────────────────────────────

function handlePacket(buf, rinfo) {
  // Try PTPv1 first (Dante default) — v1 byte 0 = 0x01, v2 byte 1 low nibble = 0x02
  const v1header = parseHeaderV1(buf);
  if (v1header) {
    handlePacketV1(buf, v1header, rinfo);
    return;
  }

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
      clock.timeSourceCode         = announce.timeSourceCode;
      clock.currentUtcOffset       = announce.currentUtcOffset;
      clock.logAnnounceInterval    = announce.logMessageInterval;
      clock.domainNumber           = domainNumber;
      clock.ptpVersion             = announce.version;
      clock.ptpTimescale           = announce.ptpTimescale;
      clock.timeTraceable          = announce.timeTraceable;
      clock.freqTraceable          = announce.freqTraceable;
      clock.ptpProfile             = detectProfile(announce.version, announce.clockClass, announce.timeSourceCode);

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
      clock.logSyncInterval = header.logMessageInterval ?? clock.logSyncInterval;

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
      // Infer clockRole:
      //   grandmaster: clockIdentity === grandmasterIdentity
      //   boundary:    explicit flag (PTPv1) OR stepsRemoved > 0 AND syncCount > 0 (PTPv2 heuristic)
      //   slave:       stepsRemoved > 0 AND syncCount == 0
      let clockRole;
      if (clock.isGrandmaster) {
        clockRole = 'grandmaster';
      } else if (clock.clockRole === 'boundary' || clock.grandmasterIsBoundaryClock) {
        clockRole = 'boundary'; // explicit from PTPv1 grandmasterIsBoundaryClock flag
      } else if ((clock.stepsRemoved ?? 0) > 0 && clock.syncCount > 0) {
        clockRole = 'boundary'; // PTPv2 heuristic
      } else {
        clockRole = 'slave';
      }

      list.push({
        clockIdentity:        clock.clockIdentity,
        displayId:            formatClockId(clock.clockIdentity),
        domainNumber:         clock.domainNumber,
        isGrandmaster:        clock.isGrandmaster,
        clockRole,
        ptpVersion:           clock.ptpVersion ?? null,
        ptpProfile:           clock.ptpProfile  || null,
        ptpTimescale:         clock.ptpTimescale ?? null,
        timeTraceable:        clock.timeTraceable ?? null,
        freqTraceable:        clock.freqTraceable ?? null,
        grandmasterIdentity:  clock.grandmasterIdentity || null,
        grandmasterDisplayId: clock.grandmasterIdentity ? formatClockId(clock.grandmasterIdentity) : null,
        priority1:            clock.grandmasterPriority1 ?? null,
        priority2:            clock.grandmasterPriority2 ?? null,
        clockClass:              clock.clockClass ?? null,
        clockAccuracy:           clock.clockAccuracy || null,
        grandmasterClockStratum: clock.grandmasterClockStratum ?? null,
        grandmasterIsBoundaryClock: clock.grandmasterIsBoundaryClock ?? null,
        timeSource:              clock.timeSource || null,
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
      process.send({
        type: 'port-conflict',
        port,
        code: 'EACCES',
        message: `PTP port ${port} access denied. On Linux, run:\n  sudo setcap cap_net_bind_service=+eip /path/to/aes67-visualizer.AppImage\nor:\n  sudo sysctl -w net.ipv4.ip_unprivileged_port_start=319`,
        source: 'ptp',
      });
    } else {
      console.error(`[PTP] Socket error port ${port}:`, err.message);
    }
    if (onError) onError(err);
  });

  sock.on('message', (buf, rinfo) => onPacket(buf, rinfo));

  sock.bind({ port, address: '0.0.0.0', exclusive: false }, () => {
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
