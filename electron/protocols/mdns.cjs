/**
 * mDNS/DNS-SD discovery — cross-platform
 *
 * Windows/macOS : uses dns-sd (Apple Bonjour)  — dns-sd -B / -L / -G
 * Linux         : uses multicast-dns (raw mDNS socket) — no avahi/D-Bus required
 *
 * Browses for Dante, RAVENNA and AES67 service types.
 */

'use strict';

const { spawn }    = require('child_process');
const os           = require('os');
const IS_LINUX     = os.platform() === 'linux';
const IS_WINDOWS   = os.platform() === 'win32';
const mdns         = IS_LINUX ? require('multicast-dns')() : null;

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
 * Resolve a .local hostname to IPv4.
 * Primary: Node.js dns.lookup() (works on Windows via Bonjour, Linux via nss-mdns/systemd-resolved)
 * Fallback Windows: dns-sd -G v4
 * Fallback Linux:   avahi-resolve-host-name -4
 *
 * @param {string}   host     e.g. "device.local."
 * @param {Function} callback (ip: string|null) => void
 */
function resolveHost(host, callback) {
  const dns = require('dns');
  const hostname = host.endsWith('.') ? host.slice(0, -1) : host;

  // Primary: Node.js dns.lookup()
  dns.lookup(hostname, { family: 4 }, (err, address) => {
    if (!err && address) {
      callback(address);
      return;
    }

    // Fallback: platform-specific resolver
    let proc, resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; try { proc.kill(); } catch(_){} callback(null); }
    }, 3000);

    const onIp = (ip) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { proc.kill(); } catch(_){}
      callback(ip);
    };

    if (IS_LINUX) {
      // Use multicast-dns raw A query — avoids avahi/D-Bus entirely
      const queryName = hostname.endsWith('.local') ? hostname : `${hostname}.local`;
      const onResponse = (response) => {
        const allRecords = [...(response.answers || []), ...(response.additionals || [])];
        const aRec = allRecords.find(r => r.type === 'A' && r.name === queryName && r.data);
        if (aRec) {
          mdns.removeListener('response', onResponse);
          onIp(aRec.data);
        }
      };
      mdns.on('response', onResponse);
      try { mdns.query({ questions: [{ name: queryName, type: 'A' }] }); } catch (_) {}
      // proc-like object for cleanup
      proc = { kill() { mdns.removeListener('response', onResponse); } };
    } else {
      proc = spawn('dns-sd', ['-G', 'v4', host], { windowsHide: true });
      proc.stdout.on('data', (data) => {
        const m = data.toString().match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
        if (m) onIp(m[1]);
      });
    }

    if (proc.on) {
      proc.on('error', () => { if (!resolved) { resolved = true; clearTimeout(timer); callback(null); } });
      proc.on('close', () => { if (!resolved) { resolved = true; callback(null); } });
      proc.stderr && proc.stderr.on('data', () => {});
    }
  });
}

/**
 * Parse TXT key=value string (shared by dns-sd and avahi-browse output)
 */
function parseTxtString(str) {
  const txt = {};
  const keyPositions = [];
  const keyRe = /(?:^|\s)([\w-]+)=/g;
  let m;
  while ((m = keyRe.exec(str)) !== null) {
    keyPositions.push({ key: m[1], valStart: m.index + m[0].length });
  }
  for (let i = 0; i < keyPositions.length; i++) {
    const { key, valStart } = keyPositions[i];
    const valEnd = i + 1 < keyPositions.length
      ? keyPositions[i + 1].valStart - keyPositions[i + 1].key.length - 1
      : str.length;
    txt[key] = str.slice(valStart, valEnd).trim().replace(/\\(.)/g, '$1');
  }
  return txt;
}

/**
 * Lookup via dns-sd -L (Windows/macOS)
 */
function lookupServiceDnsSd(name, serviceType, family, onUp) {
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
      const line = rawLine.replace(/\r/g, '');
      const reachMatch = line.match(/can be reached at ([\w.-]+):(\d+)/i);
      if (reachMatch) {
        pendingHost = reachMatch[1];
        pendingPort = parseInt(reachMatch[2]) || 0;
        continue;
      }

      if (pendingHost && line.trim() && !line.match(/^\s*Lookup/i)) {
        const txt  = parseTxtString(line.trim());
        const host = pendingHost;
        const port = pendingPort;
        pendingHost = null;
        pendingPort = 0;
        clearTimeout(timer);
        proc.kill();
        resolveHost(host, (ip) => {
          onUp({ name, type: serviceType, host, addresses: ip ? [ip] : [], port, txt, family });
        });
      }
    }
  });

  proc.on('close', () => {
    clearTimeout(timer);
    if (pendingHost) {
      const host = pendingHost;
      const port = pendingPort;
      pendingHost = null;
      resolveHost(host, (ip) => {
        onUp({ name, type: serviceType, host, addresses: ip ? [ip] : [], port, txt: {}, family });
      });
    }
  });
  proc.stderr && proc.stderr.on('data', () => {});
  proc.on('error', () => { clearTimeout(timer); });
  return proc;
}

/**
 * Lookup via avahi-browse --resolve --terminate (Linux) — active fallback
 */
function lookupServiceAvahi(name, serviceType, family, onUp) {
  const proc = spawn('avahi-browse', [
    '--resolve', '--parsable', '--terminate', '--no-db-lookup',
    serviceType,
  ]);
  const timer = setTimeout(() => proc.kill(), 8000);
  let buffer = '';

  proc.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const parts = line.split(';');
      if (parts[0] !== '=' || parts[2] !== 'IPv4') continue;
      if (parts[3] !== name) continue;

      const host    = parts[6];
      const address = parts[7];
      const port    = parseInt(parts[8]) || 0;
      const rawTxt  = parts.slice(9).join(';');
      const txt     = {};
      for (const pair of (rawTxt.match(/"([^"]*)"/g) || [])) {
        const kv = pair.slice(1, -1);
        const eq = kv.indexOf('=');
        if (eq > 0) txt[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      clearTimeout(timer);
      proc.kill();
      onUp({ name, type: serviceType, host, addresses: address ? [address] : [], port, txt, family });
      return;
    }
  });

  proc.on('close', () => { clearTimeout(timer); });
  proc.stderr && proc.stderr.on('data', () => {});
  proc.on('error', () => { clearTimeout(timer); });
  return proc;
}

/**
 * Browse using multicast-dns (Linux) — raw mDNS socket, no avahi/D-Bus required.
 * Sends PTR queries for each service type and listens for responses.
 * Works for Dante, RAVENNA and AES67 devices regardless of avahi state.
 */
function browseMdns(callbacks) {
  const { onUp, onDown } = callbacks;
  // Map: `serviceType|instanceName` → service record (for dedup + onDown)
  const active = new Map();
  // Pending SRV/TXT answers waiting for A record: key → { svc, name, port, txt }
  const pending = new Map();

  console.log('[mDNS] Starting discovery via multicast-dns (Linux)...');

  // Build lookup map: fqdn service type → SERVICES entry
  const svcByFqdn = {};
  for (const svc of SERVICES) {
    svcByFqdn[`${svc.type}.local`] = svc;
  }

  function sendQueries() {
    const questions = SERVICES.map(svc => ({ name: `${svc.type}.local`, type: 'PTR' }));
    try { mdns.query({ questions }); } catch (_) {}
  }

  // Initial query + periodic refresh every 60s
  sendQueries();
  const refreshTimer = setInterval(sendQueries, 60000);

  mdns.on('response', (response) => {
    // Collect all records from answer + additional sections
    // Normalize: strip trailing dots from names/targets (some implementations include them)
    const strip = (s) => (typeof s === 'string' && s.endsWith('.') ? s.slice(0, -1) : s);
    const allRecords = [...(response.answers || []), ...(response.additionals || [])].map(r => {
      const n = { ...r, name: strip(r.name) };
      if (r.type === 'PTR' && r.data)            n.data = strip(r.data);
      if (r.type === 'SRV' && r.data?.target)    n.data = { ...r.data, target: strip(r.data.target) };
      if (r.type === 'A'   && r.name)            {} // already stripped via name
      return n;
    });

    // Index A records: hostname → ip
    const aRecords = {};
    for (const r of allRecords) {
      if (r.type === 'A' && r.data) aRecords[r.name] = r.data;
    }

    // Process PTR records
    for (const r of allRecords) {
      if (r.type !== 'PTR') continue;
      const svc = svcByFqdn[r.name];
      if (!svc) continue;

      // r.data = "InstanceName._type._proto.local"
      const instanceFqdn = r.data;
      const instanceName = instanceFqdn.replace(`.${svc.type}.local`, '');
      const key = `${svc.type}|${instanceName}`;

      if (r.ttl === 0) {
        // Goodbye packet
        if (active.has(key)) {
          active.delete(key);
          if (onDown) onDown({ name: instanceName, host: instanceName });
        }
        continue;
      }

      if (active.has(key)) continue; // already reported

      // Find matching SRV record
      const srv = allRecords.find(x => x.type === 'SRV' && x.name === instanceFqdn);
      const txtR = allRecords.find(x => x.type === 'TXT' && x.name === instanceFqdn);

      const port = srv ? (srv.data.port || 0) : 0;
      const host = srv ? srv.data.target : null;

      // Parse TXT
      const txt = {};
      if (txtR && Array.isArray(txtR.data)) {
        for (const buf of txtR.data) {
          const str = Buffer.isBuffer(buf) ? buf.toString() : String(buf);
          const eq = str.indexOf('=');
          if (eq > 0) txt[str.slice(0, eq)] = str.slice(eq + 1);
        }
      }

      if (host && aRecords[host]) {
        // All info available inline
        const ip = aRecords[host];
        active.set(key, { name: instanceName, type: svc.type });
        onUp({ name: instanceName, type: svc.type, host, addresses: [ip], port, txt, family: svc.family });
      } else if (host) {
        // SRV found but no A record yet — query A directly via mDNS (avoids avahi/D-Bus)
        if (!pending.has(key)) {
          pending.set(key, { svc, instanceName, host, port, txt });
        }
        try { mdns.query({ questions: [{ name: host, type: 'A' }] }); } catch (_) {}
      } else {
        // PTR only — no SRV yet, query SRV+TXT
        if (!pending.has(key)) {
          pending.set(key, { svc, instanceName, host: null, port: 0, txt });
        }
        try {
          mdns.query({ questions: [
            { name: instanceFqdn, type: 'SRV' },
            { name: instanceFqdn, type: 'TXT' },
          ]});
        } catch (_) {}
      }
    }

    // Try to resolve pending entries using newly arrived SRV or A records
    for (const [key, info] of pending) {
      if (active.has(key)) { pending.delete(key); continue; }

      // If host was unknown (PTR-only), check if SRV arrived now
      if (!info.host) {
        const instanceFqdn = `${info.instanceName}.${info.svc.type}.local`;
        const srv = allRecords.find(x => x.type === 'SRV' && x.name === instanceFqdn);
        if (srv) {
          info.host = srv.data.target;
          info.port = srv.data.port || 0;
          // Also pick up TXT if present
          const txtR = allRecords.find(x => x.type === 'TXT' && x.name === instanceFqdn);
          if (txtR && Array.isArray(txtR.data)) {
            for (const buf of txtR.data) {
              const str = Buffer.isBuffer(buf) ? buf.toString() : String(buf);
              const eq = str.indexOf('=');
              if (eq > 0) info.txt[str.slice(0, eq)] = str.slice(eq + 1);
            }
          }
          // Query A record now that we have the hostname
          try { mdns.query({ questions: [{ name: info.host, type: 'A' }] }); } catch (_) {}
        }
        continue;
      }

      // Host known — check if A record has arrived
      if (aRecords[info.host]) {
        pending.delete(key);
        active.set(key, { name: info.instanceName, type: info.svc.type });
        onUp({ name: info.instanceName, type: info.svc.type, host: info.host,
          addresses: [aRecords[info.host]], port: info.port, txt: info.txt, family: info.svc.family });
      }
    }
  });

  return {
    stop() {
      clearInterval(refreshTimer);
      try { mdns.removeAllListeners('response'); } catch (_) {}
      active.clear();
      pending.clear();
      console.log('[mDNS] Stopped');
    },
  };
}

/**
 * Browse using dns-sd (Windows / macOS)
 */
function browseDnsSd(callbacks) {
  const { onUp, onDown } = callbacks;
  const browseProcs  = [];
  const lookupProcs  = [];

  console.log('[mDNS] Starting discovery via dns-sd...');

  for (const svc of SERVICES) {
    const proc = spawn('dns-sd', ['-B', svc.type, 'local'], { windowsHide: true });
    browseProcs.push(proc);
    let buffer = '';

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r/g, '').trim();
        const addMatch = line.match(/\bAdd\s+\d+\s+\d+\s+\S+\s+\S+\.\s+(.+)$/);
        if (addMatch) {
          const name = addMatch[1].trim().replace(/\\ /g, ' ');
          const lp = lookupServiceDnsSd(name, svc.type, svc.family, onUp);
          if (lp) lookupProcs.push(lp);
        } else {
          const rmvMatch = line.match(/\bRmv\s+\d+\s+\d+\s+\S+\s+\S+\.\s+(.+)$/);
          if (rmvMatch && onDown) {
            const name = rmvMatch[1].trim().replace(/\\ /g, ' ');
            onDown({ name, host: name });
          }
        }
      }
    });

    proc.stderr && proc.stderr.on('data', () => {});
    proc.on('error', (err) => {
      console.warn(`[mDNS] dns-sd error for ${svc.type}: ${err.message}`);
    });
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

function browse(callbacks) {
  if (IS_LINUX) return browseMdns(callbacks);
  return browseDnsSd(callbacks);
}

module.exports = { browse, SERVICES };
