import React from 'react';
import { ShieldCheck, ShieldAlert, ShieldX, Info } from 'lucide-react';
import { PortConflictData } from '../types';

interface PermissionsPanelProps {
  portConflicts: PortConflictData[];
  mdnsError: { code: string; message: string } | null;
}

interface PermissionRow {
  port: number | string;
  protocol: string;
  usage: string;
  windows: 'ok' | 'warn' | 'err';
  linux: 'ok' | 'warn' | 'err';
  windowsNote?: string;
  linuxNote?: string;
}

const PERMISSION_MATRIX: PermissionRow[] = [
  {
    port: 9875,
    protocol: 'UDP multicast',
    usage: 'SAP stream discovery (239.255.255.255)',
    windows: 'ok',
    linux: 'ok',
    linuxNote: 'Bind on 0.0.0.0 (already done)',
  },
  {
    port: 5353,
    protocol: 'UDP multicast',
    usage: 'mDNS device discovery — via multicast-dns raw socket (Linux) / Bonjour dns-sd (Windows)',
    windows: 'ok',
    linux: 'ok',
    windowsNote: 'Requires Bonjour Service (Apple)',
    linuxNote: 'Raw mDNS socket — no avahi/D-Bus required',
  },
  {
    port: '319, 320',
    protocol: 'UDP multicast',
    usage: 'PTP IEEE 1588 clock monitoring',
    windows: 'ok',
    linux: 'err',
    linuxNote: 'Ports <1024 require privilege — sysctl or setcap needed (see below)',
  },
  {
    port: 4440,
    protocol: 'UDP unicast',
    usage: 'Dante ARC device control (read + write)',
    windows: 'ok',
    linux: 'ok',
  },
  {
    port: '5004+',
    protocol: 'UDP multicast',
    usage: 'RTP audio metering (stream-dependent port)',
    windows: 'warn',
    linux: 'warn',
    windowsNote: 'Port 5004 may conflict with rtpMIDI driver / loopMIDI / Apple MIDI',
    linuxNote: 'Port 5004 may conflict with jackd, pipewire-jack, raveloxmidi',
  },
  {
    port: 554,
    protocol: 'TCP',
    usage: 'RTSP DESCRIBE for RAVENNA streams',
    windows: 'ok',
    linux: 'ok',
  },
];

const STATUS_ICON = {
  ok:   <ShieldCheck size={14} className="text-emerald-400 shrink-0" />,
  warn: <ShieldAlert  size={14} className="text-amber-400 shrink-0" />,
  err:  <ShieldX      size={14} className="text-red-400 shrink-0" />,
};

type OsKey = 'windows' | 'linux';
const OS_KEYS: OsKey[] = ['windows', 'linux'];
const OS_LABEL: Record<OsKey, string> = { windows: 'Windows', linux: 'Linux' };

const PermissionsPanel: React.FC<PermissionsPanelProps> = ({ portConflicts, mdnsError }) => {
  const platform = window.navigator.platform.toLowerCase();
  const currentOs: OsKey = platform.includes('win') ? 'windows' : 'linux';

  return (
    <div className="p-4 space-y-6">
      {/* Active conflicts from runtime */}
      {portConflicts.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wider flex items-center gap-1.5">
            <ShieldX size={13} /> Active Permission Issues
          </h3>
          {portConflicts.map((c, i) => (
            <div key={i} className="bg-red-950/40 border border-red-800/50 rounded-lg p-3 text-xs">
              <div className="flex items-start gap-2">
                <ShieldX size={14} className="text-red-400 mt-0.5 shrink-0" />
                <div>
                  <div className="font-medium text-red-300">
                    Port {c.port} — {c.source?.toUpperCase() || 'Unknown'}
                  </div>
                  <pre className="text-red-400/80 whitespace-pre-wrap mt-1 font-mono text-[10px]">
                    {c.message}
                  </pre>
                  {c.blockingProcess && (
                    <div className="text-red-500 mt-1">
                      Blocked by: {c.blockingProcess.name} (PID {c.blockingProcess.pid})
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Permission matrix */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
          <Info size={13} /> Required Permissions by Port
        </h3>
        <div className="rounded-lg border border-slate-700/50 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-800/60 border-b border-slate-700/50">
                <th className="text-left px-3 py-2 text-slate-400 font-medium">Port</th>
                <th className="text-left px-3 py-2 text-slate-400 font-medium">Usage</th>
                {OS_KEYS.map((os) => (
                  <th key={os} className={`text-center px-2 py-2 font-medium ${
                    os === currentOs ? 'text-white' : 'text-slate-500'
                  }`}>
                    {os === currentOs ? '★ ' : ''}{OS_LABEL[os]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/30">
              {PERMISSION_MATRIX.map((row) => (
                <tr key={String(row.port)} className="hover:bg-slate-800/30">
                  <td className="px-3 py-2 font-mono text-slate-300 whitespace-nowrap">{row.port}</td>
                  <td className="px-3 py-2 text-slate-400">
                    <div>{row.usage}</div>
                    <div className="text-slate-600 text-[10px]">{row.protocol}</div>
                    {/* Show note for current OS */}
                    {row[`${currentOs}Note` as `${OsKey}Note`] && (
                      <div className={`text-[10px] mt-0.5 ${
                        row[currentOs] === 'err' ? 'text-red-400' :
                        row[currentOs] === 'warn' ? 'text-amber-400' :
                        'text-slate-500'
                      }`}>
                        ↳ {row[`${currentOs}Note` as `${OsKey}Note`]}
                      </div>
                    )}
                  </td>
                  {OS_KEYS.map((os) => (
                    <td key={os} className="px-2 py-2 text-center">
                      <div className="flex justify-center">
                        {STATUS_ICON[row[os]]}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-OS quick reference */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
          Quick Fix Reference
        </h3>

        {/* Linux */}
        <div className={`rounded-lg border p-3 text-xs space-y-2 ${
          currentOs === 'linux'
            ? 'border-amber-700/50 bg-amber-950/20'
            : 'border-slate-700/30 bg-slate-800/20'
        }`}>
          <div className="font-semibold text-slate-300 flex items-center gap-1.5">
            🐧 Linux
            {currentOs === 'linux' && <span className="text-amber-400 text-[10px]">(current OS)</span>}
          </div>
          <div className="space-y-1.5 text-slate-400">
            {/* Avahi runtime error */}
            {mdnsError && (
              <div className="bg-amber-950/40 border border-amber-700/50 rounded p-2 text-amber-300">
                <div className="font-medium text-[10px] uppercase tracking-wide mb-0.5">
                  {mdnsError.code === 'AVAHI_NOT_FOUND' ? 'avahi-browse not found' : 'avahi-daemon not running'}
                </div>
                <pre className="whitespace-pre-wrap text-[10px] font-mono text-amber-400/80">{mdnsError.message}</pre>
              </div>
            )}
            <div>
              <span className="text-slate-300">mDNS (Avahi)</span> — dependency, not a permission issue:
            </div>
            <pre className="bg-slate-900/60 rounded px-2 py-1.5 text-[10px] font-mono text-emerald-300 whitespace-pre-wrap">
{`sudo apt install avahi-daemon avahi-utils   # Debian/Ubuntu
sudo pacman -S avahi                         # Arch
sudo dnf install avahi avahi-tools           # Fedora
sudo systemctl enable --now avahi-daemon`}
            </pre>
            <div>
              <span className="text-slate-300">PTP ports 319/320</span> — requires one of:
            </div>
            <pre className="bg-slate-900/60 rounded px-2 py-1.5 text-[10px] font-mono text-emerald-300 whitespace-pre-wrap">
{`# Option 1 — persistent (recommended):
echo "net.ipv4.ip_unprivileged_port_start=319" | sudo tee /etc/sysctl.d/99-ptp.conf
sudo sysctl -p /etc/sysctl.d/99-ptp.conf

# Option 2 — temporary (reset on reboot):
sudo sysctl -w net.ipv4.ip_unprivileged_port_start=319

# Option 3 — setcap (extract AppImage first):
./aes67-visualizer.AppImage --appimage-extract
sudo setcap cap_net_bind_service=+eip squashfs-root/aes67-visualizer`}
            </pre>
            <div>
              <span className="text-slate-300">Port 5004 conflict</span> — check with:
            </div>
            <pre className="bg-slate-900/60 rounded px-2 py-1.5 text-[10px] font-mono text-emerald-300">
{`sudo lsof -i UDP:5004   # identify conflicting process (jackd, raveloxmidi...)`}
            </pre>
          </div>
        </div>

        {/* Windows */}
        <div className={`rounded-lg border p-3 text-xs space-y-2 ${
          currentOs === 'windows'
            ? 'border-blue-700/50 bg-blue-950/20'
            : 'border-slate-700/30 bg-slate-800/20'
        }`}>
          <div className="font-semibold text-slate-300 flex items-center gap-1.5">
            🪟 Windows
            {currentOs === 'windows' && <span className="text-blue-400 text-[10px]">(current OS)</span>}
          </div>
          <div className="text-slate-400 space-y-1.5">
            <div>✅ No special permissions required for any port.</div>
            <div>
              <span className="text-slate-300">Bonjour/mDNS</span>: requires Apple Bonjour Service.{' '}
              <a
                href="https://support.apple.com/downloads/bonjour-for-windows"
                className="text-blue-400 hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                Download
              </a>
            </div>
            <div>
              <span className="text-slate-300">Firewall</span>: allow inbound UDP 9875, 5353, 319, 320, 5004.
            </div>
            <div>
              <span className="text-slate-300">Port 5004 conflict</span> — rtpMIDI driver or loopMIDI may use it:
            </div>
            <pre className="bg-slate-900/60 rounded px-2 py-1.5 text-[10px] font-mono text-emerald-300">
{`netstat -ano | findstr :5004   # identify conflicting PID`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PermissionsPanel;
