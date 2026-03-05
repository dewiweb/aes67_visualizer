/**
 * Dante ARC Protocol (Audio Routing Control)
 * Binary UDP protocol on port 4440 (or port announced via _netaudio-arc._udp mDNS)
 * Reference: network-audio-controller / netaudio_lib/dante/protocol.py
 */

'use strict';

const dgram = require('dgram');

// Protocol constants — from Inferno (gitlab.com/lumifaza/inferno) + network-audio-controller
const PROTOCOL_ID          = 0x27FF;
const OPCODE_CHANNEL_COUNT = 0x1000; // tx_channels_count(2) + rx_channels_count(2) + ...
const OPCODE_DEVICE_NAME   = 0x1002; // null-terminated device name
const OPCODE_DEVICE_INFO   = 0x1003; // board_name, revision, friendly_hostname (string pointer table)
const OPCODE_TX_CHANNELS   = 0x2000; // TX channel list: channel_id(2) + unknown(2) + common_offset(2) + name_offset(2)
const OPCODE_TX_CHAN_NAMES  = 0x2010; // TX channel friendly names
const OPCODE_RX_CHANNELS   = 0x3000; // RX channel list + subscription status
const RESULT_SUCCESS       = 0x0001;
const RESULT_SUCCESS_EXT   = 0x8112; // more pages available (paginated response)

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
  if (offset < 0 || offset >= buf.length) return '';
  const end = buf.indexOf(0, offset);
  return buf.slice(offset, end >= 0 ? end : undefined).toString('utf8').trim();
}

/**
 * Resolve a string pointer (absolute offset from start of full packet)
 * Inferno: string pointers are absolute offsets into the full response buffer
 */
function readStringAtPointer(buf, pointer) {
  // Pointers are absolute offsets in the full packet; body starts at offset 10
  const offset = pointer - 10;
  return readString(buf, offset);
}

/**
 * Parse paginated ARC channel list response body.
 * Body layout (Inferno proto_arc.rs serialize_items):
 *   byte 0: space_items (max per page)
 *   byte 1: actual_items count
 *   then: actual_items × record structs
 *   then: string heap
 */
function parsePaginatedBody(body, recordSize, parseRecord) {
  if (body.length < 2) return [];
  const count = body[1];
  const records = [];
  for (let i = 0; i < count; i++) {
    const offset = 2 + i * recordSize;
    if (offset + recordSize > body.length) break;
    records.push(parseRecord(body, offset));
  }
  return records;
}

/**
 * Build paginated query payload: page offset encoded as start index
 * Inferno extract_start_index: bytes[2:4] = start_index + 1
 */
function paginatePayload(startIndex = 0) {
  const buf = Buffer.alloc(8, 0);
  buf.writeUInt16BE(0x0000, 0);
  buf.writeUInt16BE(0x0001, 2); // page request flag
  buf.writeUInt16BE(startIndex + 1, 4); // 1-based start index
  return buf;
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

/**
 * Fetch TX channel names from a Dante device.
 * Returns array of { id, name } or [] on failure.
 * Uses OPCODE_TX_CHANNELS (0x2000) — paginated, 16 channels per page.
 */
async function getTxChannels(ip, port = DEFAULT_PORT, txCount = 0, timeout = DEFAULT_TIMEOUT) {
  const channels = [];
  const pages = Math.max(1, Math.ceil(txCount / 16));

  for (let page = 0; page < pages; page++) {
    const payload = paginatePayload(page * 16);
    const raw = await sendRequest(ip, port, buildRequest(OPCODE_TX_CHANNELS, payload), timeout * 2);
    if (!raw || raw.length < 12) break;

    const rc = raw.readUInt16BE(8);
    if (rc !== RESULT_SUCCESS && rc !== RESULT_SUCCESS_EXT) break;

    const body = raw.slice(10);
    // TX channel descriptor: channel_id(2) + unknown(2) + common_offset(2) + name_offset(2) = 8 bytes
    const parsed = parsePaginatedBody(body, 8, (buf, off) => {
      const channelId  = buf.readUInt16BE(off);
      const namePtr    = buf.readUInt16BE(off + 6);
      const name       = namePtr > 0 ? readStringAtPointer(buf, namePtr) : '';
      return { id: channelId, name };
    });
    channels.push(...parsed);
    if (rc !== RESULT_SUCCESS_EXT) break;
  }
  return channels;
}

/**
 * Fetch RX channel names + subscription status from a Dante device.
 * Returns array of { id, name, txChannelName, txHost, subscribed } or [] on failure.
 * Uses OPCODE_RX_CHANNELS (0x3000) — paginated.
 */
async function getRxChannels(ip, port = DEFAULT_PORT, rxCount = 0, timeout = DEFAULT_TIMEOUT) {
  const channels = [];
  const pages = Math.max(1, Math.ceil(rxCount / 16));

  for (let page = 0; page < pages; page++) {
    const payload = paginatePayload(page * 16);
    const raw = await sendRequest(ip, port, buildRequest(OPCODE_RX_CHANNELS, payload), timeout * 2);
    if (!raw || raw.length < 12) break;

    const rc = raw.readUInt16BE(8);
    if (rc !== RESULT_SUCCESS && rc !== RESULT_SUCCESS_EXT) break;

    const body = raw.slice(10);
    // RX channel descriptor: channel_id(2)+unk(2)+common_offset(2)+tx_ch_name_offset(2)+tx_host_offset(2)+friendly_offset(2)+status(4)+unk(4) = 20 bytes
    const parsed = parsePaginatedBody(body, 20, (buf, off) => {
      const channelId      = buf.readUInt16BE(off);
      const txChNamePtr    = buf.readUInt16BE(off + 6);
      const txHostPtr      = buf.readUInt16BE(off + 8);
      const friendlyPtr    = buf.readUInt16BE(off + 10);
      const status         = buf.readUInt32BE(off + 12);
      return {
        id:           channelId,
        name:         friendlyPtr > 0 ? readStringAtPointer(buf, friendlyPtr) : '',
        txChannelName: txChNamePtr > 0 ? readStringAtPointer(buf, txChNamePtr) : null,
        txHost:        txHostPtr   > 0 ? readStringAtPointer(buf, txHostPtr)   : null,
        subscribed:    (status & 0xFF) === 0x09 || (status & 0xFF) === 0x0A,
      };
    });
    channels.push(...parsed);
    if (rc !== RESULT_SUCCESS_EXT) break;
  }
  return channels;
}

module.exports = { query, getTxChannels, getRxChannels, DEFAULT_PORT };
