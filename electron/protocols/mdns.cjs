/**
 * mDNS/DNS-SD discovery — cross-platform
 *
 * Windows/macOS : uses dns-sd (Apple Bonjour)  — dns-sd -B / -L / -G
 * Linux         : uses avahi-browse / avahi-resolve-host-name
 *
 * Browses for Dante, RAVENNA and AES67 service types.
 */

'use strict';

const { spawn }    = require('child_process');
const os           = require('os');
const IS_LINUX     = os.platform() === 'linux';
const IS_WINDOWS   = os.platform() === 'win32';

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
      proc = spawn('avahi-resolve-host-name', ['-4', hostname]);
      proc.stdout.on('data', (data) => {
        // output: "hostname\t192.168.x.x"
        const m = data.toString().match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
        if (m) onIp(m[1]);
      });
    } else {
      proc = spawn('dns-sd', ['-G', 'v4', host], { windowsHide: true });
      proc.stdout.on('data', (data) => {
        const m = data.toString().match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
        if (m) onIp(m[1]);
      });
    }

    proc.on('error', () => { if (!resolved) { resolved = true; clearTimeout(timer); callback(null); } });
    proc.on('close', () => { if (!resolved) { resolved = true; callback(null); } });
    proc.stderr && proc.stderr.on('data', () => {});
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
 * Browse using avahi-browse (Linux)
 * Uses --resolve so each line already contains the resolved IP address.
 * avahi-browse -r -p outputs two line types per service:
 *   +;iface;IPv4;instanceName;type;domain             (announce)
 *   =;iface;IPv4;instanceName;type;domain;host;ip;port;"txt"...  (resolved)
 *   -;iface;IPv4;instanceName;type;domain             (remove)
 */
function browseAvahi(callbacks) {
  const { onUp, onDown } = callbacks;
  const browseProcs = [];

  console.log('[mDNS] Starting discovery via avahi-browse --resolve (Linux)...');

  for (const svc of SERVICES) {
    const proc = spawn('avahi-browse', [
      '--resolve', '--parsable', '--no-db-lookup', svc.type,
    ]);
    browseProcs.push(proc);
    let buffer = '';

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const parts = line.split(';');
        if (parts.length < 5) continue;
        const event = parts[0];

        if (event === '=') {
          // Resolved: =;iface;IPv4;name;type;domain;host;ip;port;"txt"...
          if (parts[2] !== 'IPv4') continue;
          const instanceName = parts[3];
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
          onUp({ name: instanceName, type: svc.type, host, addresses: address ? [address] : [], port, txt, family: svc.family });

        } else if (event === '-') {
          const instanceName = parts[3];
          if (onDown) onDown({ name: instanceName, host: instanceName });
        }
      }
    });

    let avahiErrorSent = false;

    proc.stderr && proc.stderr.on('data', (data) => {
      const msg = data.toString();
      if (!avahiErrorSent && msg.toLowerCase().includes('daemon not running')) {
        avahiErrorSent = true;
        console.warn('[mDNS] avahi-daemon is not running');
        process.send && process.send({
          type: 'mdns-error',
          code: 'AVAHI_DAEMON_NOT_RUNNING',
          message:
            'avahi-daemon is not running — mDNS device discovery is disabled.\n' +
            'Fix: sudo systemctl enable --now avahi-daemon\n' +
            'Install: sudo apt install avahi-daemon avahi-utils  (Debian/Ubuntu)\n' +
            '         sudo pacman -S avahi                        (Arch)\n' +
            '         sudo dnf install avahi avahi-tools          (Fedora)',
        });
      }
    });
    proc.on('error', (err) => {
      console.warn(`[mDNS] avahi-browse error for ${svc.type}: ${err.message}`);
      if (!avahiErrorSent && err.code === 'ENOENT') {
        avahiErrorSent = true;
        process.send && process.send({
          type: 'mdns-error',
          code: 'AVAHI_NOT_FOUND',
          message:
            'avahi-browse not found — mDNS device discovery is disabled.\n' +
            'Install: sudo apt install avahi-daemon avahi-utils  (Debian/Ubuntu)\n' +
            '         sudo pacman -S avahi                        (Arch)\n' +
            '         sudo dnf install avahi avahi-tools          (Fedora)\n' +
            'Then: sudo systemctl enable --now avahi-daemon',
        });
      }
    });
    proc.on('close', (code) => {
      const idx = browseProcs.indexOf(proc);
      if (idx >= 0) browseProcs.splice(idx, 1);
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
  if (IS_LINUX) return browseAvahi(callbacks);
  return browseDnsSd(callbacks);
}

module.exports = { browse, SERVICES };
