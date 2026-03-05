/**
 * RTSP Protocol helper for RAVENNA stream discovery
 * Implements OPTIONS → DESCRIBE sequence per RFC 2326
 * RAVENNA URL convention: rtsp://ip/by-name/<stream> or rtsp://ip/by-id/<n>
 */

'use strict';

const net = require('net');

const DEFAULT_TIMEOUT = 4000;

// Common RAVENNA/AES67 RTSP ports
const RAVENNA_RTSP_PORTS = [554, 9010, 8554, 9020, 8000, 5000, 7272];

/**
 * Send one RTSP request on an already-connected socket, collect full response.
 * Resolves with { headers, body } or null on timeout.
 */
function sendRequest(socket, method, url, cseq, extraHeaders = '') {
  return new Promise((resolve) => {
    let buffer = '';

    const onData = (data) => {
      buffer += data.toString();
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const headers = buffer.slice(0, headerEnd);
      const body    = buffer.slice(headerEnd + 4);
      const clMatch = headers.match(/Content-Length:\s*(\d+)/i);
      const contentLength = clMatch ? parseInt(clMatch[1]) : 0;

      if (contentLength === 0 || Buffer.byteLength(body) >= contentLength) {
        socket.removeListener('data', onData);
        resolve({ headers, body: body.slice(0, contentLength || body.length) });
      }
    };

    socket.on('data', onData);
    socket.write(
      `${method} ${url} RTSP/1.0\r\nCSeq: ${cseq}\r\nUser-Agent: AES67-Visualizer\r\n${extraHeaders}\r\n`
    );
  });
}

/**
 * Full RTSP DESCRIBE sequence on a single TCP connection.
 * - Sends OPTIONS * (informational only, failure does not abort)
 * - Tries DESCRIBE on /by-name/<stream> paths, then common fallbacks
 * Returns raw SDP string or null.
 *
 * @param {string}   ip          Device IP
 * @param {number}   port        RTSP port
 * @param {string[]} streamNames SAP-known stream names for /by-name/ URLs
 * @param {number}   timeout     Total timeout in ms
 */
function describe(ip, port, streamNames = [], timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled  = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => done(null), timeout);

    socket.connect(port, ip, async () => {
      try {
        // RFC 2326: omit default port 554 from URL
        const base = port === 554 ? `rtsp://${ip}` : `rtsp://${ip}:${port}`;

        // OPTIONS * — informational only, some Lawo devices return 404
        const optResp = await Promise.race([
          sendRequest(socket, 'OPTIONS', '*', 1),
          new Promise(r => setTimeout(() => r(null), 1500)),
        ]);
        const optStatus = optResp?.headers.match(/^RTSP\/1\.0\s+(\d+)/)?.[1];
        if (optStatus) console.log(`[RTSP] ${ip}:${port} OPTIONS * → ${optStatus}`);

        // Build DESCRIBE path list: /by-name/ first (RAVENNA standard), then fallbacks
        const byNamePaths = streamNames.map(n => `/by-name/${encodeURIComponent(n)}`);
        const byIdPaths   = Array.from(
          { length: Math.max(streamNames.length, 4) },
          (_, i) => `/by-id/${i + 1}`
        );
        const paths = [
          ...byNamePaths,
          '/by-name/',
          '/',
          ...byIdPaths,
          '/stream',
          '/streams',
          '/audio',
          '/ravenna',
          '/session',
        ];

        let cseq = 2;
        for (const path of paths) {
          const resp = await Promise.race([
            sendRequest(socket, 'DESCRIBE', `${base}${path}`, cseq++, 'Accept: application/sdp\r\n'),
            new Promise(r => setTimeout(() => r(null), 2000)),
          ]);

          if (!resp) continue;

          const status = resp.headers.match(/^RTSP\/1\.0\s+(\d+)/)?.[1];
          if (status === '200' && resp.body.trim().startsWith('v=')) {
            return done(resp.body.trim());
          }
          if (status && !['400', '404'].includes(status)) {
            console.log(`[RTSP] ${ip}:${port}${path} DESCRIBE ${status}`);
          }
        }

        done(null);
      } catch (_) {
        done(null);
      }
    });

    socket.on('error', () => done(null));
  });
}

/**
 * Test if a TCP port is open on an IP (fast connectivity check)
 */
function isTcpOpen(ip, port, timeout = 1000) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(timeout);
    s.connect(port, ip, () => { s.destroy(); resolve(true); });
    s.on('error',   () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

/**
 * Probe a device IP for RTSP across common RAVENNA ports.
 * Returns { port, sdp } on success or null.
 *
 * @param {string}   ip
 * @param {string[]} streamNames  SAP-known stream names for /by-name/ URLs
 */
async function probe(ip, streamNames = []) {
  for (const port of RAVENNA_RTSP_PORTS) {
    if (!(await isTcpOpen(ip, port))) continue;

    console.log(`[RTSP] ${ip}:${port} TCP open — trying DESCRIBE`);
    const sdp = await describe(ip, port, streamNames, 5000);
    if (sdp) {
      console.log(`[RTSP] ${ip}:${port} → SDP found`);
      return { port, sdp };
    }
    console.log(`[RTSP] ${ip}:${port} open but no SDP`);
  }
  return null;
}

module.exports = { describe, probe, RAVENNA_RTSP_PORTS };
