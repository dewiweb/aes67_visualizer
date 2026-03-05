/**
 * mDNS/DNS-SD discovery via dns-sd.exe (Apple Bonjour native, Windows)
 * Browses for Dante, RAVENNA and AES67 service types.
 * Uses dns-sd -B (browse), -L (lookup), -G (host → IP resolution).
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const LOG_FILE = require('os').tmpdir() + '/aes67_discovery.log';
function flog(msg) {
  try { fs.appendFileSync(LOG_FILE, new Date().toISOString().slice(11,23) + ' [mdns] ' + msg + '\n'); } catch(_) {}
}

// mDNS service types and their protocol families
// Sources: network-audio-controller, Inferno (gitlab.com/lumifaza/inferno)
const SERVICES = [
  { type: '_netaudio-arc._udp',  family: 'dante',  role: 'control'  }, // ARC: device info, channels, subscriptions (port 4440)
  { type: '_netaudio-cmc._udp',  family: 'dante',  role: 'clock'    }, // CMC: clock domain management
  { type: '_netaudio-dbc._udp',  family: 'dante',  role: 'control'  }, // DBC: Dante Broadway Control
  { type: '_netaudio-chan._udp', family: 'dante',  role: 'channel'  }, // per-TX-channel announcement: "ChannelName@Hostname"
  { type: '_netaudio-bund._udp', family: 'dante',  role: 'bundle'   }, // multicast bundles (flows)
  { type: '_ravenna._tcp',       family: 'ravenna', role: 'device'  },
  { type: '_ravenna-session._tcp', family: 'ravenna', role: 'stream' },
  { type: '_aes67._udp',         family: 'aes67',   role: 'device'  },
];

/**
 * Resolve a .local hostname to IPv4 via dns-sd -G v4
 * @param {string}   host     e.g. "device.local."
 * @param {Function} callback (ip: string|null) => void
 */
function resolveHost(host, callback) {
  const proc = spawn('dns-sd', ['-G', 'v4', host], { windowsHide: true });
  let resolved = false;

  const timer = setTimeout(() => {
    if (!resolved) { resolved = true; proc.kill(); callback(null); }
  }, 3000);

  proc.stdout.on('data', (data) => {
    if (resolved) return;
    const match = data.toString().match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    if (match) {
      resolved = true;
      clearTimeout(timer);
      proc.kill();
      callback(match[1]);
    }
  });

  proc.on('close', () => { if (!resolved) { resolved = true; callback(null); } });
  proc.stderr.on('data', () => {});
}

/**
 * Resolve a service instance via dns-sd -L (lookup)
 * Extracts host, port and TXT records, then resolves host to IP.
 * Calls onUp({ name, type, host, addresses, port, txt, family }) on success.
 *
 * @param {string}   name        Service instance name
 * @param {string}   serviceType Full service type e.g. "_netaudio-arc._udp"
 * @param {string}   family      Protocol family
 * @param {Function} onUp        Called with resolved service object
 * @returns {ChildProcess}
 */
function lookupService(name, serviceType, family, onUp) {
  const proc = spawn('dns-sd', ['-L', name, serviceType, 'local'], { windowsHide: true });
  let buffer = '';
  const timer = setTimeout(() => proc.kill(), 5000);

  let pendingHost = null;
  let pendingPort = 0;

  proc.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r/g, ''); // strip CR
      flog(`lookup[${name}] raw: ${JSON.stringify(line)}`);

      // Line 1: "  <name> can be reached at <host>:<port> (interface N)"
      const reachMatch = line.match(/can be reached at ([\w.-]+):(\d+)/i);
      if (reachMatch) {
        pendingHost = reachMatch[1];
        pendingPort = parseInt(reachMatch[2]) || 0;
        flog(`lookup[${name}] host=${pendingHost} port=${pendingPort}`);
        continue;
      }

      // Line 2 (immediately after): TXT key=value pairs
      // e.g. " arcp_vers=2.8.9 mf=Powersoft model=X router_info=Audinate\ DCM"
      if (pendingHost && line.trim() && !line.match(/^\s*Lookup/i)) {
        const txt = {};
        // Split on whitespace but not escaped spaces (backslash-space)
        const raw = line.trim().replace(/\\\s/g, '\u00A0'); // temporarily replace "\ " with NBSP
        for (const kv of raw.split(/\s+/)) {
          const eq = kv.indexOf('=');
          if (eq > 0) {
            const key = kv.slice(0, eq);
            const val = kv.slice(eq + 1).replace(/\u00A0/g, ' '); // restore spaces
            txt[key] = val;
          }
        }

        const host = pendingHost;
        const port = pendingPort;
        pendingHost = null;
        pendingPort = 0;

        clearTimeout(timer);
        proc.kill();

        resolveHost(host, (ip) => {
          onUp({
            name,
            type:      serviceType,
            host,
            addresses: ip ? [ip] : [],
            port,
            txt,
            family,
          });
        });
      }
    }
  });

  proc.on('close', () => {
    clearTimeout(timer);
    flog(`lookup[${name}] closed, pendingHost=${pendingHost}`);
    // If we got a host but no TXT line came (e.g. device has no TXT records), still emit
    if (pendingHost) {
      const host = pendingHost;
      const port = pendingPort;
      pendingHost = null;
      resolveHost(host, (ip) => {
        onUp({ name, type: serviceType, host, addresses: ip ? [ip] : [], port, txt: {}, family });
      });
    }
  });
  proc.stderr.on('data', () => {});
  return proc;
}

/**
 * Browse for all known service types and call onUp/onDown on changes.
 *
 * @param {{ onUp: Function, onDown: Function }} callbacks
 * @returns {{ stop: Function }}  Handle to stop all processes
 */
function browse(callbacks) {
  const { onUp, onDown } = callbacks;
  const browseProcs  = [];
  const lookupProcs  = [];

  console.log('[mDNS] Starting discovery via dns-sd.exe...');

  for (const svc of SERVICES) {
    console.log(`[mDNS] Browsing ${svc.type}`);

    const proc = spawn('dns-sd', ['-B', svc.type, 'local'], { windowsHide: true });
    browseProcs.push(proc);

    let buffer = '';

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r/g, '').trim(); // strip CRLF
        if (line) flog(`browse[${svc.type}] raw: ${JSON.stringify(line)}`);

        // dns-sd output: "HH:MM:SS.mmm  Add  flags if domain  type  name"
        // or just:       "Add  flags if domain  type  name" (no timestamp)
        const addMatch = line.match(/\bAdd\s+\d+\s+\d+\s+\S+\s+\S+\.\s+(.+)$/);
        if (addMatch) {
          const name = addMatch[1].trim().replace(/\\ /g, ' ');
          flog(`browse[${svc.type}] Add: ${JSON.stringify(name)}`);
          const lp = lookupService(name, svc.type, svc.family, onUp);
          lookupProcs.push(lp);
        } else {
          const rmvMatch = line.match(/\bRmv\s+\d+\s+\d+\s+\S+\s+\S+\.\s+(.+)$/);
          if (rmvMatch && onDown) {
            const name = rmvMatch[1].trim().replace(/\\ /g, ' ');
            onDown({ name, host: name });
          }
        }
      }
    });

    proc.stderr.on('data', () => {});
    proc.on('close', (code) => {
      const idx = browseProcs.indexOf(proc);
      if (idx >= 0) browseProcs.splice(idx, 1);
      if (code !== null && code !== 0) {
        console.warn(`[mDNS] dns-sd exited ${code} for ${svc.type}`);
      }
    });
  }

  return {
    stop() {
      for (const p of [...browseProcs, ...lookupProcs]) {
        try { p.kill(); } catch (_) {}
      }
      browseProcs.length = 0;
      lookupProcs.length = 0;
      console.log('[mDNS] Stopped');
    },
  };
}

module.exports = { browse, SERVICES };
