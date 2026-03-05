/**
 * SAP — Session Announcement Protocol (RFC 2974)
 * Multicast discovery on 239.255.255.255:9875
 * Used by AES67, RAVENNA and Dante (AES67 mode) to announce RTP streams via SDP.
 */

'use strict';

const dgram   = require('dgram');
const crypto  = require('crypto');

const MULTICAST_ADDR = '239.255.255.255';
const PORT           = 9875;

// SAP packet header offsets
const HEADER_MIN_LENGTH = 8;
const CONTENT_TYPE      = 'application/sdp';
const CONTENT_TYPE_LEN  = CONTENT_TYPE.length; // 15

/**
 * Parse a raw SAP UDP packet.
 * Returns { isDelete, rawSdp, sourceHash } or null if invalid.
 *
 * SAP header layout (RFC 2974 §3):
 *   byte 0:    V(3) A(1) R(1) T(1) E(1) C(1)  — flags
 *   byte 1:    auth length
 *   bytes 2-3: message id hash
 *   bytes 4-7: originating source (IPv4)
 *   [auth data — auth_len × 4 bytes]
 *   payload type string + NUL + SDP body
 */
function parsePacket(buf) {
  if (buf.length <= HEADER_MIN_LENGTH + CONTENT_TYPE_LEN + 1) return null;

  // Content type starts at offset 8, must be "application/sdp"
  const contentType = buf.toString('ascii', HEADER_MIN_LENGTH, HEADER_MIN_LENGTH + CONTENT_TYPE_LEN);
  if (contentType !== CONTENT_TYPE) return null;

  // SDP starts after content type + NUL terminator
  const sdpStart = HEADER_MIN_LENGTH + CONTENT_TYPE_LEN + 1;
  if (sdpStart >= buf.length) return null;

  const isDelete = (buf.readUInt8(0) & 0x04) === 0x04;
  const rawSdp   = buf.toString('utf8', sdpStart);

  return { isDelete, rawSdp };
}

/**
 * Generate a stable session ID from an SDP origin object.
 */
function sessionId(origin) {
  return crypto.createHash('md5').update(JSON.stringify(origin)).digest('hex');
}

/**
 * Open a UDP multicast socket bound to the given interface address
 * and call onPacket(buf, rinfo) for each SAP message received.
 *
 * Returns { close() } handle.
 */
function listen(interfaceAddress, onPacket, onError) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('error', (err) => {
    if (onError) onError(err);
  });

  sock.on('message', (buf, rinfo) => {
    onPacket(buf, rinfo);
  });

  sock.bind({ port: PORT, address: interfaceAddress, exclusive: false }, () => {
    try {
      sock.setMulticastInterface(interfaceAddress);
      sock.addMembership(MULTICAST_ADDR, interfaceAddress);
    } catch (e) {
      if (onError) onError(e);
    }
  });

  return {
    changeInterface(newAddress, oldAddress) {
      try {
        if (oldAddress) sock.dropMembership(MULTICAST_ADDR, oldAddress);
        sock.setMulticastInterface(newAddress);
        sock.addMembership(MULTICAST_ADDR, newAddress);
      } catch (e) {
        if (onError) onError(e);
      }
    },
    close() {
      try { sock.close(); } catch (_) {}
    },
  };
}

module.exports = { parsePacket, sessionId, listen, PORT, MULTICAST_ADDR };
