import React from 'react';
import { ShieldCheck, ShieldAlert, ShieldX, Info } from 'lucide-react';
import { PortConflictData } from '../types';

interface PermissionsPanelProps {
  portConflicts: PortConflictData[];
}

interface PermissionRow {
  port: number | string;
  protocol: string;
  usage: string;
  windows: 'ok' | 'warn' | 'err';
  linux: 'ok' | 'warn' | 'err';
  macos: 'ok' | 'warn' | 'err';
  windowsNote?: string;
  linuxNote?: string;
  macosNote?: string;
}

const PERMISSION_MATRIX: PermissionRow[] = [
  {
    port: 9875,
    protocol: 'UDP multicast',
    usage: 'SAP stream discovery (239.255.255.255)',
    windows: 'ok',
    linux: 'ok',
    macos: 'ok',
    linuxNote: 'Requires bind on 0.0.0.0 (already done)',
  },
  {
    port: 5353,
    protocol: 'UDP multicast',
    usage: 'mDNS device discovery (224.0.0.251)',
    windows: 'ok',
    linux: 'warn',
    macos: 'ok',
    windowsNote: 'Via Bonjour (dns-sd)',
    linuxNote: 'Requires avahi-daemon running. Install: sudo apt install avahi-daemon avahi-utils',
    macosNote: 'Via mDNSResponder (built-in)',
  },
  {
    port: '319, 320',
    protocol: 'UDP multicast',
    usage: 'PTP IEEE 1588 clock monitoring',
    windows: 'ok',
    linux: 'err',
    macos: 'ok',
    linuxNote: 'Ports <1024 require privilege. Fix: sudo setcap cap_net_bind_service=+eip /path/to/app  OR  sudo sysctl -w net.ipv4.ip_unprivileged_port_start=319',
    windowsNote: 'No special permissions needed',
    macosNote: 'No special permissions needed',
  },
  {
    port: 4440,
    protocol: 'UDP unicast',
    usage: 'Dante ARC device control (read + write)',
    windows: 'ok',
    linux: 'ok',
    macos: 'ok',
  },
  {
    port: '5004+',
    protocol: 'UDP multicast',
    usage: 'RTP audio metering (stream-dependent)',
    windows: 'warn',
    linux: 'warn',
    macos: 'warn',
    windowsNote: 'Port 5004 may conflict with Apple MIDI / loopMIDI / rtpMIDI driver',
    linuxNote: 'Port 5004 may conflict with jackd, pipewire-jack, raveloxmidi. Check: sudo lsof -i UDP:5004',
    macosNote: 'Port 5004 often used by Apple RTP MIDI (rtpmidi). Fix: System Settings → General → AirDrop & Handoff → disable "AirPlay Receiver"',
  },
  {
    port: 554,
    protocol: 'TCP',
    usage: 'RTSP DESCRIBE for RAVENNA streams',
    windows: 'ok',
    linux: 'ok',
    macos: 'ok',
  },
];

const STATUS_ICON = {
  ok:   <ShieldCheck size={14} className="text-emerald-400 shrink-0" />,
  warn: <ShieldAlert  size={14} className="text-amber-400 shrink-0" />,
  err:  <ShieldX      size={14} className="text-red-400 shrink-0" />,
};

const OS_LABEL = ['Windows', 'Linux', 'macOS'] as const;
type OsKey = 'windows' | 'linux' | 'macos';
const OS_KEYS: OsKey[] = ['windows', 'linux', 'macos'];

const PermissionsPanel: React.FC<PermissionsPanelProps> = ({ portConflicts }) => {
  const platform = window.navigator.platform.toLowerCase();
  const currentOs: OsKey = platform.includes('win')
    ? 'windows'
    : platform.includes('mac') || platform.includes('darwin')
    ? 'macos'
    : 'linux';

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
                {OS_KEYS.map((os, i) => (
                  <th key={os} className={`text-center px-2 py-2 font-medium ${
                    os === currentOs ? 'text-white' : 'text-slate-500'
                  }`}>
                    {os === currentOs ? '★ ' : ''}{OS_LABEL[i]}
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
            <div>
              <span className="text-slate-300">PTP ports 319/320</span> — requires one of:
            </div>
            <pre className="bg-slate-900/60 rounded px-2 py-1.5 text-[10px] font-mono text-emerald-300 whitespace-pre-wrap">
{`# Option 1: kernel parameter (temporary, reset on reboot)
sudo sysctl -w net.ipv4.ip_unprivileged_port_start=319

# Option 2: kernel parameter (persistent)
echo "net.ipv4.ip_unprivileged_port_start=319" | sudo tee /etc/sysctl.d/99-ptp.conf
sudo sysctl -p /etc/sysctl.d/99-ptp.conf

# Option 3: setcap on the extracted binary
sudo setcap cap_net_bind_service=+eip /path/to/aes67-visualizer`}
            </pre>
            <div>
              <span className="text-slate-300">mDNS (Avahi)</span>:
            </div>
            <pre className="bg-slate-900/60 rounded px-2 py-1.5 text-[10px] font-mono text-emerald-300">
{`sudo apt install avahi-daemon avahi-utils   # Debian/Ubuntu
sudo systemctl enable --now avahi-daemon`}
            </pre>
            <div className="text-slate-500 text-[10px]">
              ℹ AppImage: setcap cannot be applied directly to an AppImage. Extract first with{' '}
              <code className="bg-slate-900/60 px-1 rounded">./aes67-visualizer.AppImage --appimage-extract</code>,
              then apply setcap to the extracted binary inside <code className="bg-slate-900/60 px-1 rounded">squashfs-root/</code>.
            </div>
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
          <div className="text-slate-400 space-y-1">
            <div>✅ No special permissions required for any port.</div>
            <div>
              <span className="text-slate-300">Bonjour/mDNS</span>: requires Apple Bonjour Service (installed with iTunes or standalone).
              <a
                href="https://support.apple.com/downloads/bonjour-for-windows"
                className="text-blue-400 hover:underline ml-1"
                target="_blank"
                rel="noreferrer"
              >
                Download
              </a>
            </div>
            <div>
              <span className="text-slate-300">Firewall</span>: allow inbound UDP on ports 9875, 5353, 319, 320, 5004 for this app.
            </div>
          </div>
        </div>

        {/* macOS */}
        <div className={`rounded-lg border p-3 text-xs space-y-2 ${
          currentOs === 'macos'
            ? 'border-slate-500/50 bg-slate-800/30'
            : 'border-slate-700/30 bg-slate-800/20'
        }`}>
          <div className="font-semibold text-slate-300 flex items-center gap-1.5">
            🍎 macOS
            {currentOs === 'macos' && <span className="text-slate-400 text-[10px]">(current OS)</span>}
          </div>
          <div className="text-slate-400 space-y-1.5">
            <div>✅ mDNS via built-in mDNSResponder — no setup needed.</div>
            <div>✅ PTP ports 319/320 accessible without privilege.</div>
            <div>
              <span className="text-slate-300">Firewall</span>: System Settings → Network → Firewall → allow incoming connections for AES67 Visualizer.
            </div>
            <div className="border-t border-slate-700/40 pt-1.5">
              <span className="text-amber-300">⚠ Port 5004 — RTP MIDI conflict</span>
              <div className="mt-1">macOS 10.14+ enables Apple RTP MIDI (rtpmidi) by default on UDP 5004.</div>
              <div className="mt-1 font-medium text-slate-300">Fix (macOS 13+):</div>
              <pre className="bg-slate-900/60 rounded px-2 py-1.5 text-[10px] font-mono text-emerald-300 whitespace-pre-wrap mt-1">
{`System Settings → General → AirDrop & Handoff → disable "AirPlay Receiver"`}
              </pre>
              <div className="mt-1 font-medium text-slate-300">Fix (all versions, terminal):</div>
              <pre className="bg-slate-900/60 rounded px-2 py-1.5 text-[10px] font-mono text-emerald-300 whitespace-pre-wrap mt-1">
{`sudo launchctl unload -w /System/Library/LaunchDaemons/com.apple.rtpmidid.plist`}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PermissionsPanel;
