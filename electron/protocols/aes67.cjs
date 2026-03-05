/**
 * AES67 Protocol helpers
 * AES67 is an interoperability standard (IEEE, 2013) for audio-over-IP.
 *
 * AES67 defines:
 *   - Transport:  RTP/UDP, multicast or unicast
 *   - Codecs:     L16 or L24, 48kHz (or multiples: 44.1k, 88.2k, 96k, 192k)
 *   - Timing:     PTP IEEE 1588-2008 (ts-refclk SDP attribute)
 *   - Discovery:  SAP/SDP on 239.255.255.255:9875
 *
 * AES67 does NOT define: device discovery, routing, control.
 * Those are handled by higher-level protocols (Dante, RAVENNA, NMOS).
 */

'use strict';

// Codecs mandated by AES67
const SUPPORTED_CODECS = ['L16', 'L24'];

// Sample rates allowed by AES67 (48kHz family + 44.1kHz family)
const SUPPORTED_SAMPLE_RATES = [16000, 32000, 44100, 48000, 88200, 96000, 192000];

// Maximum channels per AES67 stream (practical limit)
const MAX_CHANNELS = 64;

/**
 * Validate and enrich a parsed SDP object for AES67 compatibility.
 * Adds: isSupported, unsupportedReason, codec, sampleRate, channels,
 *       port, ptime, mcast, deviceIp, ptpVersion, ptpGrandmaster,
 *       ptpDomain, mediaclk, tool, redundant, dante.
 *
 * @param {object} sdp   Parsed SDP from sdp-transform
 * @param {string} raw   Original raw SDP string (for attribute extraction)
 * @returns {object}     Mutated sdp object
 */
function validateSdp(sdp, raw) {
  // ── Media section checks ───────────────────────────────────────────────────
  if (!sdp.media || sdp.media.length === 0) {
    return _reject(sdp, 'No media section');
  }

  for (const media of sdp.media) {
    if (media.type !== 'audio' || media.protocol !== 'RTP/AVP') {
      return _reject(sdp, 'Unsupported media type');
    }
    if (!media.rtp || media.rtp.length !== 1) {
      return _reject(sdp, 'Unsupported rtpmap');
    }

    const rtp = media.rtp[0];

    if (!SUPPORTED_SAMPLE_RATES.includes(rtp.rate)) {
      return _reject(sdp, `Unsupported sample rate: ${rtp.rate}`);
    }
    if (!SUPPORTED_CODECS.includes(rtp.codec)) {
      return _reject(sdp, `Unsupported codec: ${rtp.codec}`);
    }
    if (rtp.encoding < 1 || rtp.encoding > MAX_CHANNELS) {
      return _reject(sdp, `Unsupported channel count: ${rtp.encoding}`);
    }
  }

  sdp.isSupported = true;

  // ── Multicast address ──────────────────────────────────────────────────────
  if (sdp.media[0]?.connection?.ip) {
    sdp.mcast = sdp.media[0].connection.ip.split('/')[0];
  } else if (sdp.connection?.ip) {
    sdp.mcast = sdp.connection.ip.split('/')[0];
  } else {
    return _reject(sdp, 'No multicast address');
  }

  // ── Audio parameters ───────────────────────────────────────────────────────
  const media = sdp.media[0];
  const rtp   = media.rtp[0];
  sdp.codec      = rtp.codec;
  sdp.sampleRate = rtp.rate;
  sdp.channels   = rtp.encoding;
  sdp.port       = media.port;
  sdp.ptime      = media.ptime || 1; // AES67 default packet time: 1ms

  // ── Origin (device IP, session ID) ────────────────────────────────────────
  if (sdp.origin) {
    sdp.deviceIp       = sdp.origin.address;
    sdp.sessionId      = sdp.origin.sessionId;
    sdp.sessionVersion = sdp.origin.sessionVersion;
  }

  // ── PTP clock reference (a=ts-refclk) ─────────────────────────────────────
  // Formats (per AES67, confirmed by PAM/RavennaKit source):
  //   a=ts-refclk:ptp=IEEE1588-2008:GM-EUI64:domain
  //   a=ts-refclk:ptp=IEEE1588-2008:traceable
  //   a=ts-refclk:ntp=<server>
  //   a=ts-refclk:localmac=<mac>
  // RAVENNA also uses:
  //   a=clock-domain:PTP V2 <domain>  → implies PTP IEEE1588-2008
  if (raw) {
    const ptpMatch = raw.match(/a=ts-refclk:ptp=(IEEE1588-\d+):([0-9A-Fa-f-]+):?(\d*)/i);
    if (ptpMatch) {
      sdp.ptpVersion     = ptpMatch[1];
      sdp.ptpGrandmaster = ptpMatch[2].toUpperCase();
      sdp.ptpDomain      = ptpMatch[3] !== undefined ? ptpMatch[3] : '0';
    } else {
      const traceableMatch = raw.match(/a=ts-refclk:ptp=(IEEE1588-\d+):traceable/i);
      if (traceableMatch) {
        sdp.ptpVersion     = traceableMatch[1];
        sdp.ptpGrandmaster = 'traceable';
        sdp.ptpDomain      = '0';
      } else {
        const ntpMatch = raw.match(/a=ts-refclk:ntp=(.+)/i);
        if (ntpMatch) sdp.clockRef = `ntp=${ntpMatch[1].trim()}`;

        const macMatch = raw.match(/a=ts-refclk:localmac=([0-9A-Fa-f:-]+)/i);
        if (macMatch) sdp.clockRef = `localmac=${macMatch[1].trim()}`;
      }
    }

    // a=clock-domain:PTP V2 <domain>  (RAVENNA extension — confirmed by PAM)
    if (!sdp.ptpVersion) {
      const clockDomainMatch = raw.match(/a=clock-domain:PTP\s+V(\d+)\s+(\d+)/i);
      if (clockDomainMatch) {
        sdp.ptpVersion     = `IEEE1588-200${clockDomainMatch[1] === '1' ? '2' : '8'}`;
        sdp.ptpDomain      = clockDomainMatch[2];
        sdp.ptpGrandmaster = sdp.ptpGrandmaster || null;
      }
    }

    // a=mediaclk:direct=<offset>
    const mediaclkMatch = raw.match(/a=mediaclk:(.+)/);
    if (mediaclkMatch) sdp.mediaclk = mediaclkMatch[1].trim();

    // a=tool:<software name>
    const toolMatch = raw.match(/a=tool:(.+)/);
    if (toolMatch) sdp.tool = toolMatch[1].trim();
  }

  // ── ST2022-7 redundancy (DUP group) ───────────────────────────────────────
  if (sdp.groups) {
    const dupGroup = sdp.groups.find(g => g.type === 'DUP');
    if (dupGroup) {
      sdp.redundant      = true;
      sdp.redundantMids  = dupGroup.mids;
    }
  }
  sdp.mid = media.mid;

  // ── Dante streams (keyword "Dante" in SDP k= field) ───────────────────────
  sdp.dante = sdp.keywords === 'Dante';

  sdp.description = sdp.description || media.description || '';
  sdp.info        = sdp.description || null;

  return sdp;
}

/**
 * Check if an SDP object (already validated) uses AES67 PTP clocking.
 */
function isPtpClocked(sdp) {
  return !!(sdp.ptpVersion && sdp.ptpGrandmaster);
}

/**
 * Determine protocol family from a validated SDP object.
 * Returns 'dante' | 'ravenna' | 'aes67'
 */
function detectFamily(sdp) {
  if (sdp.dante) return 'dante';
  // RAVENNA streams have tool strings containing "Lawo" / "RAVENNA" or specific PTP domains
  if (sdp.tool && /lawo|ravenna|merging/i.test(sdp.tool)) return 'ravenna';
  return 'aes67';
}

function _reject(sdp, reason) {
  sdp.isSupported      = false;
  sdp.unsupportedReason = reason;
  return sdp;
}

module.exports = {
  validateSdp,
  isPtpClocked,
  detectFamily,
  SUPPORTED_CODECS,
  SUPPORTED_SAMPLE_RATES,
};
