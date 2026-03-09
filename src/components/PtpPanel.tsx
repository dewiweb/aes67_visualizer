import React, { useState, useMemo } from 'react';
import { PtpClock, DanteDevice } from '../types';

interface PtpPanelProps {
  clocks: PtpClock[];
  allDevices: DanteDevice[];
}

function clockClassLabel(cls: number | null): string {
  if (cls === null) return '—';
  if (cls <= 6)   return `${cls} (primary ref)`;
  if (cls <= 52)  return `${cls} (primary ref, holdover)`;
  if (cls <= 127) return `${cls} (primary ref, locked)`;
  if (cls === 135) return '135 (slave only)';
  if (cls <= 187) return `${cls} (app specific)`;
  if (cls <= 193) return `${cls} (app specific, holdover)`;
  if (cls <= 255) return `${cls} (default)`;
  return String(cls);
}

function logIntervalLabel(log: number | null): string {
  if (log === null) return '—';
  const seconds = Math.pow(2, log);
  if (seconds >= 1) return `${seconds}s`;
  return `${Math.round(1 / seconds * 1000)}ms`;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 2)  return 'now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

const Row: React.FC<{ label: string; value: React.ReactNode; highlight?: boolean }> = ({ label, value, highlight }) => (
  <div className={`flex justify-between items-center py-0.5 ${highlight ? 'text-amber-300' : ''}`}>
    <span className="text-slate-400 text-xs">{label}</span>
    <span className="text-xs font-mono ml-2 text-right max-w-[60%] truncate" title={String(value)}>{value ?? '—'}</span>
  </div>
);

/**
 * Normalise a raw hex string (with or without separators) to XX:XX:XX:XX:XX:XX uppercase.
 * Handles both EUI-48 (6 bytes = 12 hex chars) and strips FF:FE from EUI-64 (8 bytes = 16 hex chars).
 * Returns null if the input is unrecognisable.
 */
function normaliseToEui48(raw: string): string | null {
  // Strip all non-hex characters
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length === 12) {
    // EUI-48: 6 bytes
    return hex.match(/.{2}/g)!.join(':');
  }
  if (hex.length === 16) {
    // EUI-64: remove bytes 4-5 (FF FE at positions 6-9 in 0-indexed hex string)
    // xx xx xx [FF FE] xx xx xx -> bytes 0-2 + 5-7
    const b = hex.match(/.{2}/g)!;
    if (b[3] === 'FF' && b[4] === 'FE') {
      return [b[0], b[1], b[2], b[5], b[6], b[7]].join(':');
    }
    // Non-standard EUI-64 (e.g. Dante PTPv1 synthetic): just take first 6 bytes as fallback
    return null;
  }
  return null;
}

/**
 * Extract the EUI-48 MAC from a PTP clock identity (EUI-64 string XX-XX-XX-XX-XX-XX-XX-XX).
 * Standard EUI-64: XX-XX-XX-FF-FE-XX-XX-XX -> XX:XX:XX:XX:XX:XX
 * Non-standard (e.g. Dante PTPv1 01:01:00:...): returns null (no MAC to match)
 */
function clockIdentityToMac(id: string): string | null {
  const parts = id.split('-');
  if (parts.length !== 8) return null;
  // Standard EUI-64 with FF-FE marker
  if (parts[3].toUpperCase() === 'FF' && parts[4].toUpperCase() === 'FE') {
    return [parts[0], parts[1], parts[2], parts[5], parts[6], parts[7]].join(':').toUpperCase();
  }
  // Also try: some devices build EUI-64 without FF-FE (just pad with 00-00)
  // In that case try matching all 6 significant bytes directly
  return null;
}

/**
 * Build a map: normalised EUI-48 MAC -> device name.
 */
function buildMacMap(devices: DanteDevice[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const d of devices) {
    if (d.macAddress) {
      const mac = normaliseToEui48(d.macAddress);
      if (mac) m.set(mac, d.name || d.ip);
    }
  }
  return m;
}

/**
 * Build a map: IP address -> device name.
 * Covers Dante, RAVENNA, AES67 devices discovered via mDNS.
 */
function buildIpMap(devices: DanteDevice[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const d of devices) {
    if (d.ip && d.name) m.set(d.ip, d.name);
    // Also index secondary addresses if present
    for (const addr of (d.addresses ?? [])) {
      if (addr && d.name) m.set(addr, d.name);
    }
  }
  return m;
}

const ClockCard: React.FC<{ clock: PtpClock; macMap: Map<string, string>; ipMap: Map<string, string> }> = ({ clock, macMap, ipMap }) => {
  const [expanded, setExpanded] = useState(false);

  const borderColor = clock.clockRole === 'grandmaster'
    ? 'border-amber-500'
    : clock.clockRole === 'boundary'
    ? 'border-purple-500'
    : clock.stepsRemoved === 1
    ? 'border-blue-500'
    : 'border-slate-600';

  const roleLabel = clock.clockRole === 'grandmaster'
    ? '★ GM'
    : clock.clockRole === 'boundary'
    ? '⇄ BC'
    : clock.stepsRemoved != null
    ? `Slave (${clock.stepsRemoved})`
    : 'Clock';

  const roleLabelFull = clock.clockRole === 'grandmaster'
    ? 'Grandmaster'
    : clock.clockRole === 'boundary'
    ? 'Boundary Clock'
    : clock.stepsRemoved != null
    ? `Slave — ${clock.stepsRemoved} hop${clock.stepsRemoved > 1 ? 's' : ''} from GM`
    : 'Clock';

  const roleBadgeColor = clock.clockRole === 'grandmaster'
    ? 'bg-amber-600 text-amber-100'
    : clock.clockRole === 'boundary'
    ? 'bg-purple-700 text-purple-100'
    : 'bg-blue-700 text-blue-100';

  return (
    <div className={`border rounded-lg mb-2 overflow-hidden ${borderColor}`}>
      <button
        className="w-full flex items-center justify-between p-2 bg-slate-800 hover:bg-slate-750 text-left"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${roleBadgeColor}`} title={roleLabelFull}>
            {roleLabel}
          </span>
          <div className="flex flex-col min-w-0">
            {(() => {
              const mac = clockIdentityToMac(clock.clockIdentity);
              const deviceName =
                (clock.senderIp ? ipMap.get(clock.senderIp) : undefined) ??
                (mac ? macMap.get(mac) : undefined);
              const subtitle = deviceName
                ? (clock.senderIp ?? clock.displayId)
                : null;
              return deviceName ? (
                <>
                  <span className="text-xs font-medium text-white truncate">{deviceName}</span>
                  <span className="text-[10px] font-mono text-slate-500 truncate">{subtitle}</span>
                </>
              ) : (
                <>
                  <span className="text-xs font-mono text-slate-200 truncate">{clock.displayId}</span>
                  {clock.senderIp && (
                    <span className="text-[10px] font-mono text-slate-500 truncate">{clock.senderIp}</span>
                  )}
                </>
              );
            })()}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {clock.ptpVersion && (
            <span className="text-[10px] text-slate-500 font-mono">v{clock.ptpVersion}</span>
          )}
          {clock.ptpProfile && (
            <span className="text-[10px] text-slate-500 truncate max-w-[80px]" title={clock.ptpProfile}>
              {clock.ptpProfile.split(' ')[0]}
            </span>
          )}
          <span className="text-xs text-slate-500">D{clock.domainNumber}</span>
          <span className="text-slate-500 text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && (
        <div className="px-3 py-2 bg-slate-850 border-t border-slate-700 space-y-0.5">
          <Row label="Clock ID"         value={clock.clockIdentity} />
          <Row label="Role"             value={roleLabelFull} />
          {clock.ptpVersion != null && (
            <Row label="PTP Version"    value={`IEEE 1588-${clock.ptpVersion === 1 ? '2002' : '2008/2019'} (v${clock.ptpVersion})`} />
          )}
          {clock.ptpProfile && (
            <Row label="Profile"        value={clock.ptpProfile} />
          )}
          {clock.senderIp && (
            <Row label="Source IP"      value={clock.senderIp} />
          )}
          {clock.grandmasterDisplayId && !clock.isGrandmaster && (() => {
            const gmMac = clock.grandmasterIdentity ? clockIdentityToMac(clock.grandmasterIdentity) : null;
            const gmName = gmMac ? macMap.get(gmMac) : undefined;
            return (
              <Row
                label="Grandmaster"
                value={gmName ? `${gmName} (${clock.grandmasterDisplayId})` : clock.grandmasterDisplayId}
                highlight
              />
            );
          })()}
          <Row label="Domain"           value={clock.domainNumber} />
          <Row label="Priority 1"       value={clock.priority1} />
          <Row label="Priority 2"       value={clock.priority2} />
          {clock.clockClass != null && (
            <Row label="Clock Class"    value={clockClassLabel(clock.clockClass)} />
          )}
          <Row label="Accuracy"         value={clock.clockAccuracy} />
          {clock.grandmasterClockStratum != null && (
            <Row label="GM Stratum (v1)" value={`${clock.grandmasterClockStratum} — ${clock.clockAccuracy || ''}`} />
          )}
          {clock.grandmasterIsBoundaryClock != null && (
            <Row label="GM is BC"        value={clock.grandmasterIsBoundaryClock ? '✓ Yes (explicit)' : '✗ No'} />
          )}
          <Row label="Time Source"      value={clock.timeSource} />
          <Row label="UTC Offset"       value={clock.currentUtcOffset != null ? `${clock.currentUtcOffset}s` : null} />
          <Row label="Steps Removed"    value={clock.stepsRemoved} />

          <div className="border-t border-slate-700 mt-1 pt-1">
            <Row label="Sync interval"     value={logIntervalLabel(clock.logSyncInterval)} />
            <Row label="Announce interval" value={logIntervalLabel(clock.logAnnounceInterval)} />
            {clock.ptpTimescale != null && (
              <Row label="PTP Timescale"   value={clock.ptpTimescale ? 'Yes (TAI)' : 'No (ARB)'} />
            )}
            {clock.timeTraceable != null && (
              <Row label="Time traceable"  value={clock.timeTraceable  ? '✓ Yes' : '✗ No'} />
            )}
            {clock.freqTraceable != null && (
              <Row label="Freq traceable"  value={clock.freqTraceable  ? '✓ Yes' : '✗ No'} />
            )}
          </div>

          {clock.offsetSamples > 0 && (
            <div className="border-t border-slate-700 mt-1 pt-1">
              <p className="text-slate-500 text-xs mb-0.5">Offset from master (indicative)</p>
              <Row label="Mean"     value={clock.offsetMeanUs != null   ? `${clock.offsetMeanUs.toFixed(1)} µs` : null} />
              <Row label="Std dev"  value={clock.offsetStddevUs != null ? `${clock.offsetStddevUs.toFixed(1)} µs` : null} />
              <Row label="Samples"  value={clock.offsetSamples} />
            </div>
          )}

          <div className="border-t border-slate-700 mt-1 pt-1">
            <Row label="Announce pkts" value={clock.announceCount} />
            <Row label="Sync pkts"     value={clock.syncCount} />
            <Row label="Last seen"     value={timeAgo(clock.lastSeen)} />
          </div>
        </div>
      )}
    </div>
  );
};

const PtpPanel: React.FC<PtpPanelProps> = ({ clocks, allDevices }) => {
  const macMap = useMemo(() => buildMacMap(allDevices), [allDevices]);
  const ipMap  = useMemo(() => buildIpMap(allDevices),  [allDevices]);
  const domains = [...new Set(clocks.map(c => c.domainNumber))].sort((a, b) => a - b);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700">
        <h3 className="text-sm font-semibold text-slate-200">PTP Clocks (IEEE 1588)</h3>
        <span className="text-xs text-slate-500">
          {clocks.length} clock{clocks.length !== 1 ? 's' : ''}
          {domains.length > 1 ? ` · ${domains.length} domains` : ''}
        </span>
      </div>

      {clocks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-slate-500 text-sm p-4 text-center">
          <div className="text-3xl mb-2">⏱</div>
          <p>No PTP clocks detected</p>
          <p className="text-xs mt-1">Listening on 224.0.1.129 ports 319/320</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-2">
          {/* Domain conflict warning */}
          {domains.length > 1 && (
            <div className="mb-2 p-2 bg-amber-900/40 border border-amber-600 rounded text-xs text-amber-300">
              ⚠ Multiple PTP domains detected ({domains.map(d => `D${d}`).join(', ')}).
              AES67 streams may not be synchronized.
            </div>
          )}

          {/* Group clocks by domain */}
          {domains.map(domain => {
            const domainClocks = clocks.filter(c => c.domainNumber === domain);
            const gm = domainClocks.find(c => c.isGrandmaster);
            return (
              <div key={domain} className="mb-3">
                {domains.length > 1 && (() => {
                  const gmMac = gm?.grandmasterIdentity ? clockIdentityToMac(gm.grandmasterIdentity) : null;
                  const gmName =
                    (gm?.senderIp ? ipMap.get(gm.senderIp) : undefined) ??
                    (gmMac ? macMap.get(gmMac) : undefined);
                  const gmLabel = gm ? (gmName ? `${gmName} (${gm.displayId})` : gm.displayId) : 'No grandmaster';
                  return (
                    <div className="text-xs text-slate-500 mb-1 px-1">
                      Domain {domain} · GM: {gmLabel}
                    </div>
                  );
                })()}
                {domainClocks.map(clock => (
                  <ClockCard key={clock.clockIdentity} clock={clock} macMap={macMap} ipMap={ipMap} />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default PtpPanel;
