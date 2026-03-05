/**
 * Dante ARC Protocol (Audio Routing Control)
 * Binary UDP protocol on port 4440 (or port announced via _netaudio-arc._udp mDNS)
 * Reference: network-audio-controller / netaudio_lib/dante/protocol.py
 */

'use strict';

const dgram = require('dgram');

// Protocol constants
const PROTOCOL_ID          = 0x27FF;
const OPCODE_CHANNEL_COUNT = 0x1000;
const OPCODE_DEVICE_NAME   = 0x1002;
const OPCODE_DEVICE_INFO   = 0x1003;
const RESULT_SUCCESS       = 0x0001;
const RESULT_SUCCESS_EXT   = 0x8112;

const DEFAULT_PORT    = 4440;
const DEFAULT_TIMEOUT = 800;

/**
 * Build an ARC request packet
 * Header layout (big-endian): protocol(2) + length(2) + transaction_id(2) + opcode(2) + payload
 */
function buildRequest(opcode, payload = Buffer.from([0x00, 0x00])) {
  const txId   = Math.floor(Math.random() * 0xFFFF);
  const length = 8 + payload.length;
  const header = Buffer.alloc(8);
  header.writeUInt16BE(PROTOCOL_ID, 0);
  header.writeUInt16BE(length,      2);
  header.writeUInt16BE(txId,        4);
  header.writeUInt16BE(opcode,      6);
  return Buffer.concat([header, payload]);
}

/**
 * Send one UDP request and wait for first response
 */
function sendRequest(ip, port, packet, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let settled = false;

    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch (_) {}
      resolve(v);
    };

    const timer = setTimeout(() => done(null), timeout);
    sock.on('error', () => done(null));
    sock.on('message', (msg) => done(msg));
    sock.send(packet, port, ip, (err) => { if (err) done(null); });
  });
}

/**
 * Parse null-terminated UTF-8 string from buffer at offset
 */
function readString(buf, offset = 0) {
  const end = buf.indexOf(0, offset);
  return buf.slice(offset, end >= 0 ? end : undefined).toString('utf8').trim();
}

/**
 * Query a Dante device via ARC — all 3 requests run in parallel.
 * Returns { deviceName, model, txChannels, rxChannels } or null if no response.
 */
async function query(ip, port = DEFAULT_PORT, timeout = DEFAULT_TIMEOUT) {
  const [ccRaw, nameRaw, infoRaw] = await Promise.all([
    sendRequest(ip, port, buildRequest(OPCODE_CHANNEL_COUNT), timeout),
    sendRequest(ip, port, buildRequest(OPCODE_DEVICE_NAME),   timeout),
    sendRequest(ip, port, buildRequest(OPCODE_DEVICE_INFO),   timeout),
  ]);

  const result = {};

  // Channel count — response body (offset 10): flags(2) tx(2) rx(2) tx_active(2) rx_active(2) max_tx(2) max_rx(2)
  if (ccRaw && ccRaw.length >= 24) {
    const rc = ccRaw.readUInt16BE(8);
    if (rc === RESULT_SUCCESS || rc === RESULT_SUCCESS_EXT) {
      result.txChannels = ccRaw.readUInt16BE(12);
      result.rxChannels = ccRaw.readUInt16BE(14);
    }
  }

  // Device name — body starts at offset 10, null-terminated ASCII
  if (nameRaw && nameRaw.length > 10 && nameRaw.readUInt16BE(8) === RESULT_SUCCESS) {
    const name = readString(nameRaw, 10);
    if (name) result.deviceName = name;
  }

  // Device info — model string located via pointer at body[12:14]
  if (infoRaw && infoRaw.length > 28 && infoRaw.readUInt16BE(8) === RESULT_SUCCESS) {
    try {
      const body      = infoRaw.slice(10);
      const modelPtr  = body.readUInt16BE(12);
      const strOffset = modelPtr - 10;
      if (strOffset > 0 && strOffset < body.length) {
        const model = readString(body, strOffset);
        if (model) result.model = model;
      }
    } catch (_) {}
  }

  return (result.txChannels !== undefined || result.deviceName) ? result : null;
}

module.exports = { query, DEFAULT_PORT };
