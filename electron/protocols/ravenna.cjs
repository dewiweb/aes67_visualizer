/**
 * RAVENNA Protocol helpers
 * RAVENNA is an open AES67-compatible audio-over-IP standard by Lawo / ALC NetworX.
 *
 * RAVENNA defines (on top of AES67):
 *   - Device discovery:  mDNS/DNS-SD  _ravenna._tcp  _ravenna-session._tcp
 *   - Stream discovery:  SAP/SDP (systematic, unlike Dante which only uses SAP in AES67 mode)
 *   - Stream control:    RTSP (RFC 2326) — GET SDP via DESCRIBE
 *   - URL convention:    rtsp://ip/by-name/<StreamName>  or  rtsp://ip/by-id/<n>
 *   - Clocking:          PTP IEEE 1588-2008 only (no proprietary clock)
 *
 * Known manufacturers: Lawo, Merging Technologies, Axia, DirectOut
 *
 * mDNS TXT records for _ravenna._tcp:
 *   ver=<version>   src=<tx_count>   snk=<rx_count>
 *   ch=<channels>   sr=<sample_rate>  ptp=<grandmaster_id>
 *   model=<model>   mf=<manufacturer>
 */

'use strict';

// mDNS service types specific to RAVENNA
const MDNS_SERVICES = [
  { type: '_ravenna._tcp',         role: 'device'  },
  { type: '_ravenna-session._tcp', role: 'session' },
];

// Default RTSP port (RFC 2326)
const RTSP_PORT = 554;

// Known RAVENNA manufacturer strings (for device identification)
const KNOWN_MANUFACTURERS = [
  'lawo', 'merging', 'axia', 'directout', 'alc networx', 'l-acoustics',
];

/**
 * Parse RAVENNA mDNS TXT records into a normalised device descriptor.
 *
 * @param {string} name     Service instance name
 * @param {string} host     Hostname (e.g. "device.local.")
 * @param {string[]} addresses  IPv4 addresses
 * @param {number} port     Service port
 * @param {object} txt      Key-value TXT record pairs
 * @returns {object}        Normalised device descriptor
 */
function parseDevice(name, host, addresses, port, txt = {}) {
  return {
    name,
    host,
    addresses,
    port:           port || RTSP_PORT,
    protocolFamily: 'ravenna',
    model:          txt.model || txt.dname || null,
    manufacturer:   txt.mf    || txt.manufacturer || null,
    sampleRate:     txt.sr    ? parseInt(txt.sr)  : 48000,
    txChannels:     txt.src   ? parseInt(txt.src) : null,
    rxChannels:     txt.snk   ? parseInt(txt.snk) : null,
    ptpGrandmaster: txt.ptp   || null,
    software:       txt.ver   || null,
    isDante:        false,
    isAES67:        true,  // RAVENNA is always AES67-compatible
    isRAVENNA:      true,
    requiresAES67:  false,
  };
}

/**
 * Detect if a device is RAVENNA based on mDNS service type or manufacturer string.
 *
 * @param {string} serviceType   Full mDNS service type
 * @param {string} manufacturer  Optional manufacturer string
 * @returns {boolean}
 */
function isRavennaDevice(serviceType, manufacturer = '') {
  if (MDNS_SERVICES.some(s => serviceType.includes(s.type.split('.')[0]))) return true;
  if (KNOWN_MANUFACTURERS.some(m => manufacturer.toLowerCase().includes(m))) return true;
  return false;
}

/**
 * Build RTSP URL candidates for a RAVENNA device.
 * RAVENNA convention: rtsp://ip/by-name/<StreamName>  or  rtsp://ip/by-id/<n>
 *
 * @param {string}   ip           Device IP
 * @param {number}   port         RTSP port (default 554)
 * @param {string[]} streamNames  Known SAP stream names for this device
 * @returns {string[]}            Ordered list of URL paths to try
 */
function buildRtspPaths(streamNames = []) {
  const byName = streamNames.map(n => `/by-name/${encodeURIComponent(n)}`);
  const byId   = Array.from({ length: Math.max(streamNames.length, 4) }, (_, i) => `/by-id/${i + 1}`);
  return [
    ...byName,
    '/by-name/',   // list endpoint (some devices support it)
    '/',
    ...byId,
    '/stream',
    '/streams',
    '/audio',
    '/ravenna',
    '/session',
  ];
}

/**
 * Identify RAVENNA streams from a validated AES67 SDP object.
 * RAVENNA streams typically come from devices whose tool or origin indicates Lawo/Merging.
 *
 * @param {object} sdp  Validated AES67 SDP object
 * @returns {boolean}
 */
function isRavennaSdp(sdp) {
  if (!sdp || !sdp.isSupported) return false;
  const tool = (sdp.tool || '').toLowerCase();
  const name = (sdp.name || '').toLowerCase();
  return KNOWN_MANUFACTURERS.some(m => tool.includes(m) || name.includes(m));
}

module.exports = {
  parseDevice,
  isRavennaDevice,
  buildRtspPaths,
  isRavennaSdp,
  MDNS_SERVICES,
  RTSP_PORT,
  KNOWN_MANUFACTURERS,
};
