import React, { useMemo } from 'react';
import { Stream, DanteDevice } from '../types';
import { Server, Clock, Layers, ChevronDown, ChevronRight, AlertCircle, ArrowUpFromLine, ArrowDownToLine } from 'lucide-react';

interface DevicePanelProps {
  streams: Stream[];
  danteDevices: DanteDevice[];
  t: Record<string, string>;
  onStreamClick?: (stream: Stream) => void;
}

/** Unified view entry: mDNS device info + SAP streams, keyed by IP */
interface UnifiedDevice {
  ip: string;
  dante: DanteDevice | null;
  streams: Stream[];
  ptpGrandmaster?: string;
  ptpVersion?: string;
  ptpDomain?: string;
}

/**
 * Build a single unified list keyed by IP.
 * Combines danteDevices (mDNS/ARC) with SAP streams — one entry per IP.
 */
function buildUnifiedList(danteDevices: DanteDevice[], streams: Stream[]): UnifiedDevice[] {
  const map = new Map<string, UnifiedDevice>();

  // Seed from mDNS/ARC devices
  for (const dd of danteDevices) {
    const ip = dd.ip || dd.addresses.find(a => /^\d+\./.test(a)) || dd.host || '';
    if (!ip) continue;
    if (!map.has(ip)) map.set(ip, { ip, dante: dd, streams: [] });
    else map.get(ip)!.dante = dd;
  }

  // Merge SAP streams into existing entries or create new ones
  for (const stream of streams) {
    const ip = stream.deviceIp || stream.sapSourceIp || 'unknown';
    if (!map.has(ip)) map.set(ip, { ip, dante: null, streams: [] });
    const entry = map.get(ip)!;
    entry.streams.push(stream);
    if (stream.ptpGrandmaster && !entry.ptpGrandmaster) {
      entry.ptpGrandmaster = stream.ptpGrandmaster;
      entry.ptpVersion = stream.ptpVersion;
      entry.ptpDomain  = stream.ptpDomain;
    }
  }

  return Array.from(map.values()).sort((a, b) => a.ip.localeCompare(b.ip));
}

const DevicePanel: React.FC<DevicePanelProps> = ({ streams, danteDevices, t, onStreamClick }) => {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const toggle = (ip: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(ip)) next.delete(ip); else next.add(ip);
      return next;
    });
  };

  const unified = useMemo(
    () => buildUnifiedList(danteDevices, streams),
    [danteDevices, streams]
  );

  if (unified.length === 0) {
    return (
      <div className="p-4 text-slate-500 text-sm text-center">
        {t.noDevices || 'No devices detected'}
      </div>
    );
  }

  return (
    <div className="grid gap-2 p-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 auto-rows-min">
      {unified.map(({ ip, dante: dd, streams: devStreams, ptpGrandmaster, ptpVersion, ptpDomain }) => {
        const isExpanded   = expanded.has(ip);
        const hasChannels  = (dd?.txChannelNames?.length ?? 0) > 0 || (dd?.rxChannelNames?.length ?? 0) > 0;
        const isExpandable = hasChannels || devStreams.length > 0;
        const totalCh      = devStreams.reduce((s, st) => s + (st.channels || 0), 0);

        // Protocol colour: teal=RAVENNA, blue=AES67, purple=Dante, slate=SAP-only
        const borderColor = dd?.isRAVENNA ? 'border-teal-900/40'
                          : dd?.isAES67   ? 'border-blue-900/40'
                          : dd            ? 'border-purple-900/40'
                          : 'border-slate-700/40';
        const iconColor   = dd?.isRAVENNA ? 'text-teal-400'
                          : dd?.isAES67   ? 'text-blue-400'
                          : dd            ? 'text-purple-400'
                          : 'text-slate-400';

        return (
          <div key={ip} className={`bg-slate-800 rounded-lg overflow-hidden border ${borderColor}`}>
            <button
              onClick={() => isExpandable && toggle(ip)}
              className={`w-full flex items-center gap-3 p-3 text-left ${
                isExpandable ? 'hover:bg-slate-700/50 cursor-pointer' : 'cursor-default'
              } transition-colors`}
            >
              <Server size={18} className={`${iconColor} shrink-0`} />

              <div className="flex-1 min-w-0">
                {/* Row 1: name + protocol badges */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-medium text-sm text-white truncate">
                    {dd?.name || ip}
                  </span>
                  {dd?.isRAVENNA && (
                    <span className="text-[10px] bg-teal-900/50 text-teal-300 px-1.5 py-0.5 rounded">RAVENNA</span>
                  )}
                  {dd?.isDante && !dd.isRAVENNA && (
                    <span className="text-[10px] bg-purple-900/50 text-purple-300 px-1.5 py-0.5 rounded">Dante</span>
                  )}
                  {dd?.isAES67 && (
                    <span className="text-[10px] bg-blue-900/50 text-blue-300 px-1.5 py-0.5 rounded">AES67</span>
                  )}
                  {devStreams.length > 0 && (
                    <span className="text-[10px] bg-green-900/50 text-green-300 px-1.5 py-0.5 rounded">
                      {devStreams.length} {t.streams || 'streams'}
                    </span>
                  )}
                </div>

                {/* Row 2: IP + manufacturer + model + software */}
                <div className="flex items-center gap-2 text-xs mt-0.5 flex-wrap">
                  <span className="font-mono text-slate-500">{ip}</span>
                  {dd?.manufacturer && <span className="text-slate-400">{dd.manufacturer}</span>}
                  {dd?.model        && <span className="text-slate-500">{dd.model}</span>}
                  {dd?.software     && <span className="text-slate-600 italic">{dd.software}</span>}
                </div>

                {/* Row 3: TX/RX counts + sample rate + stream channel count + fw */}
                <div className="flex items-center gap-2 text-xs text-slate-500 mt-0.5 flex-wrap">
                  {dd?.txChannels != null && (
                    <span className="flex items-center gap-1 text-emerald-400">
                      <ArrowUpFromLine size={10} />{dd.txChannels} TX
                    </span>
                  )}
                  {dd?.rxChannels != null && (
                    <span className="flex items-center gap-1 text-sky-400">
                      <ArrowDownToLine size={10} />{dd.rxChannels} RX
                    </span>
                  )}
                  {dd?.sampleRate && <span>{dd.sampleRate / 1000}kHz</span>}
                  {totalCh > 0 && (
                    <span className="flex items-center gap-1">
                      <Layers size={10} />{totalCh} ch
                    </span>
                  )}
                  {dd?.routerVers && <span className="text-slate-600">fw {dd.routerVers}</span>}
                </div>

                {dd?.isDante && !dd.isAES67 && (
                  <div className="flex items-center gap-1 mt-1 text-[10px] text-yellow-500">
                    <AlertCircle size={10} />
                    <span>Enable AES67 on device to stream</span>
                  </div>
                )}
              </div>

              {isExpandable && (
                isExpanded
                  ? <ChevronDown size={14} className="text-slate-500 shrink-0" />
                  : <ChevronRight size={14} className="text-slate-500 shrink-0" />
              )}
            </button>

            {/* Expanded content */}
            {isExpanded && (
              <div className="border-t border-slate-700/60">

                {/* PTP info (from SAP SDP) */}
                {ptpGrandmaster && (
                  <div className="px-3 py-2 bg-slate-900/50 flex items-center gap-2 text-xs">
                    <Clock size={11} className="text-green-400 shrink-0" />
                    <span className="text-slate-400">PTP</span>
                    <span className="text-green-300 font-mono text-[10px]">{ptpGrandmaster}</span>
                    {ptpVersion && <span className="text-slate-600">{ptpVersion}</span>}
                    {ptpDomain  && <span className="text-slate-600">Dom {ptpDomain}</span>}
                  </div>
                )}

                {/* TX channel names */}
                {(dd?.txChannelNames?.length ?? 0) > 0 && (
                  <div className="px-3 py-2 border-t border-slate-700/40">
                    <div className="flex items-center gap-1.5 text-[10px] text-emerald-400 font-medium mb-1.5">
                      <ArrowUpFromLine size={10} /> TX Channels
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                      {dd!.txChannelNames.map(ch => (
                        <div key={ch.id} className="flex items-center gap-1.5 text-[10px] text-slate-300">
                          <span className="text-slate-600 w-5 text-right shrink-0">{ch.id}</span>
                          <span className="truncate">{ch.name || `ch${ch.id}`}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* RX channel names */}
                {(dd?.rxChannelNames?.length ?? 0) > 0 && (
                  <div className="px-3 py-2 border-t border-slate-700/40">
                    <div className="flex items-center gap-1.5 text-[10px] text-sky-400 font-medium mb-1.5">
                      <ArrowDownToLine size={10} /> RX Channels
                    </div>
                    <div className="space-y-0.5">
                      {dd!.rxChannelNames.map(ch => (
                        <div key={ch.id} className="flex items-center gap-1.5 text-[10px]">
                          <span className="text-slate-600 w-5 text-right shrink-0">{ch.id}</span>
                          <span className="text-slate-300 truncate">{ch.name || `ch${ch.id}`}</span>
                          {ch.subscribed && ch.txHost && (
                            <span className="text-slate-500 truncate ml-auto">
                              ← {ch.txHost.replace(/\.local\.?$/, '')}
                            </span>
                          )}
                          {ch.subscribed && (
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* SAP streams list */}
                {devStreams.length > 0 && (
                  <div className="divide-y divide-slate-700/50 border-t border-slate-700/40">
                    {devStreams.map(stream => (
                      <div
                        key={stream.id}
                        onClick={() => onStreamClick?.(stream)}
                        className="px-3 py-2 hover:bg-slate-700/30 cursor-pointer transition-colors"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-slate-300 truncate">{stream.name}</span>
                          <div className="flex items-center gap-1 text-[10px]">
                            <span className="bg-slate-700 px-1.5 py-0.5 rounded text-slate-300">{stream.codec}</span>
                            <span className="bg-slate-700 px-1.5 py-0.5 rounded text-slate-300">{stream.channels}ch</span>
                            {stream.redundant && (
                              <span className="bg-orange-900/50 px-1.5 py-0.5 rounded text-orange-300">ST2022-7</span>
                            )}
                          </div>
                        </div>
                        <div className="text-[10px] text-slate-500 mt-0.5">
                          {stream.mcast}:{stream.port}
                          {stream.info && <span className="ml-2 text-slate-600">• {stream.info}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default DevicePanel;
