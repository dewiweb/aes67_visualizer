import React, { useMemo, useState, useRef } from 'react';
import { Stream, NetworkDevice } from '../types';
import { Server, Clock, Layers, ChevronDown, ChevronRight, AlertCircle, ArrowUpFromLine, ArrowDownToLine, Pencil, Check, X, Link, Unlink } from 'lucide-react';

/** Routing picker state: which (rxDeviceIp, rxChannelId) is being routed */
interface RoutingTarget {
  rxIp: string;
  rxChannelId: number;
  rxChannelName: string;
}

interface DevicePanelProps {
  streams: Stream[];
  devices: NetworkDevice[];
  t: Record<string, string>;
  onStreamClick?: (stream: Stream) => void;
}

/** Unified view entry: mDNS device info + SAP streams, keyed by IP */
interface UnifiedDevice {
  ip: string;
  dante: NetworkDevice | null;
  streams: Stream[];
  ptpGrandmaster?: string;
  ptpVersion?: string;
  ptpDomain?: string;
}

/**
 * Build a single unified list keyed by IP.
 * Combines NetworkDevices (mDNS/ARC) with SAP streams — one entry per IP.
 */
function buildUnifiedList(devices: NetworkDevice[], streams: Stream[]): UnifiedDevice[] {
  const map = new Map<string, UnifiedDevice>();

  // Seed from mDNS/ARC devices
  for (const dd of devices) {
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

const DevicePanel: React.FC<DevicePanelProps> = ({ streams, devices, t, onStreamClick }) => {
  const [expanded, setExpanded]   = React.useState<Set<string>>(new Set());
  const [renaming, setRenaming]   = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [renameStatus, setRenameStatus] = useState<Record<string, 'ok' | 'err' | null>>({});
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Routing state: key = `${rxIp}:${rxChannelId}`
  const [routingTarget, setRoutingTarget] = useState<RoutingTarget | null>(null);
  const [routeStatus, setRouteStatus] = useState<Record<string, 'ok' | 'err' | null>>({});

  const routeKey = (ip: string, chId: number) => `${ip}:${chId}`;

  const startRoute = (e: React.MouseEvent, rxIp: string, rxChannelId: number, rxChannelName: string) => {
    e.stopPropagation();
    setRoutingTarget(prev =>
      prev?.rxIp === rxIp && prev?.rxChannelId === rxChannelId ? null : { rxIp, rxChannelId, rxChannelName }
    );
  };

  const applyRoute = async (txDeviceName: string, txChannelName: string) => {
    if (!routingTarget || !window.api?.arcSetSubscription) return;
    const { rxIp, rxChannelId } = routingTarget;
    const key = routeKey(rxIp, rxChannelId);
    setRoutingTarget(null);
    const { ok } = await window.api.arcSetSubscription(rxIp, null, rxChannelId, txChannelName, txDeviceName);
    setRouteStatus(prev => ({ ...prev, [key]: ok ? 'ok' : 'err' }));
    setTimeout(() => setRouteStatus(prev => ({ ...prev, [key]: null })), 3000);
  };

  const removeRoute = async (e: React.MouseEvent, rxIp: string, rxChannelId: number) => {
    e.stopPropagation();
    if (!window.api?.arcUnsubscribeRx) return;
    const key = routeKey(rxIp, rxChannelId);
    const { ok } = await window.api.arcUnsubscribeRx(rxIp, null, rxChannelId);
    setRouteStatus(prev => ({ ...prev, [key]: ok ? 'ok' : 'err' }));
    setTimeout(() => setRouteStatus(prev => ({ ...prev, [key]: null })), 3000);
  };

  const toggle = (ip: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(ip)) next.delete(ip); else next.add(ip);
      return next;
    });
  };

  const startRename = (ip: string, currentName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenaming(ip);
    setRenameVal(currentName);
    setTimeout(() => renameInputRef.current?.select(), 50);
  };

  const cancelRename = () => { setRenaming(null); setRenameVal(''); };

  const confirmRename = async (ip: string) => {
    const name = renameVal.trim().slice(0, 31);
    setRenaming(null);
    if (!window.api?.arcSetDeviceName) return;
    const { ok } = await window.api.arcSetDeviceName(ip, null, name || null);
    setRenameStatus(prev => ({ ...prev, [ip]: ok ? 'ok' : 'err' }));
    setTimeout(() => setRenameStatus(prev => ({ ...prev, [ip]: null })), 3000);
  };

  const unified = useMemo(
    () => buildUnifiedList(devices, streams),
    [devices, streams]
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

        // AES67 effective: mDNS flag OR dante-aes67 SAP streams present for this device
        const hasDanteAes67Streams = devStreams.some(s => s.streamFamily === 'dante-aes67');
        const effectiveAES67 = dd?.isAES67 || hasDanteAes67Streams;

        // Protocol colour: teal=RAVENNA, blue=AES67, purple=Dante, slate=SAP-only
        const borderColor = dd?.isRAVENNA    ? 'border-teal-900/40'
                          : effectiveAES67   ? 'border-blue-900/40'
                          : dd              ? 'border-purple-900/40'
                          : 'border-slate-700/40';
        const iconColor   = dd?.isRAVENNA    ? 'text-teal-400'
                          : effectiveAES67   ? 'text-blue-400'
                          : dd              ? 'text-purple-400'
                          : 'text-slate-400';

        return (
          <div key={ip} className={`bg-slate-800 rounded-lg overflow-hidden border ${borderColor}`}>
            <div
              onClick={() => isExpandable && toggle(ip)}
              role={isExpandable ? 'button' : undefined}
              tabIndex={isExpandable ? 0 : undefined}
              onKeyDown={isExpandable ? (e) => (e.key === 'Enter' || e.key === ' ') && toggle(ip) : undefined}
              className={`w-full flex items-center gap-3 p-3 text-left ${
                isExpandable ? 'hover:bg-slate-700/50 cursor-pointer' : 'cursor-default'
              } transition-colors`}
            >
              <Server size={18} className={`${iconColor} shrink-0`} />

              <div className="flex-1 min-w-0">
                {/* Row 1: name + protocol badges */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  {/* Inline rename for Dante devices */}
                  {renaming === ip ? (
                    <form
                      className="flex items-center gap-1"
                      onSubmit={e => { e.preventDefault(); confirmRename(ip); }}
                    >
                      <input
                        ref={renameInputRef}
                        value={renameVal}
                        onChange={e => setRenameVal(e.target.value)}
                        maxLength={31}
                        className="bg-slate-700 border border-blue-500 rounded px-1.5 py-0.5 text-sm text-white w-36 focus:outline-none"
                        autoFocus
                      />
                      <button type="submit" className="text-emerald-400 hover:text-emerald-300 p-0.5">
                        <Check size={13} />
                      </button>
                      <button type="button" onClick={cancelRename} className="text-slate-500 hover:text-slate-300 p-0.5">
                        <X size={13} />
                      </button>
                    </form>
                  ) : (
                    <span className="flex items-center gap-1 group">
                      <span className={`font-medium text-sm truncate ${
                        renameStatus[ip] === 'ok'  ? 'text-emerald-400' :
                        renameStatus[ip] === 'err' ? 'text-red-400' : 'text-white'
                      }`}>
                        {dd?.name || ip}
                      </span>
                      {dd?.isDante && (
                        <button
                          onClick={e => startRename(ip, dd?.name || '', e)}
                          className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-slate-300 transition-opacity p-0.5"
                          title="Rename device"
                        >
                          <Pencil size={10} />
                        </button>
                      )}
                    </span>
                  )}
                  {dd?.isRAVENNA && (
                    <span className="text-[10px] bg-teal-900/50 text-teal-300 px-1.5 py-0.5 rounded">RAVENNA</span>
                  )}
                  {dd?.isDante && !dd.isRAVENNA && (
                    <span className="text-[10px] bg-purple-900/50 text-purple-300 px-1.5 py-0.5 rounded">Dante</span>
                  )}
                  {dd?.isDante && (
                    effectiveAES67
                      ? <span className="text-[10px] bg-blue-900/50 text-blue-300 px-1.5 py-0.5 rounded">AES67 ✓</span>
                      : <span className="text-[10px] bg-slate-700/60 text-slate-500 px-1.5 py-0.5 rounded">AES67 ✗</span>
                  )}
                  {devStreams.length > 0 && (
                    <span className="text-[10px] bg-green-900/50 text-green-300 px-1.5 py-0.5 rounded">
                      {devStreams.length} {t.streams || 'streams'}
                    </span>
                  )}
                </div>

                {/* Row 2: IP + MAC + manufacturer + model + software */}
                <div className="flex items-center gap-2 text-xs mt-0.5 flex-wrap">
                  <span className="font-mono text-slate-500">{ip}</span>
                  {dd?.macAddress && (
                    <span className="font-mono text-slate-600 text-[9px]">
                      {dd.macAddress.replace(/(.{2})(?=.)/g, '$1:').toUpperCase()}
                    </span>
                  )}
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

                {dd?.isDante && !effectiveAES67 && (
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
            </div>

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

                {/* TX channel names — enriched with SAP stream info when available */}
                {(dd?.txChannelNames?.length ?? 0) > 0 && (() => {
                  const txWithStreams = dd!.txChannelNames.map(ch => {
                    const chName = ch.name || `ch${ch.id}`;
                    const sapStream = devStreams.find(s =>
                      s.name === chName ||
                      s.name === `${chName}@${dd?.name || ip}` ||
                      s.name?.startsWith(chName + ' ')
                    );
                    return { ch, chName, sapStream };
                  });
                  const hasSap = txWithStreams.some(x => x.sapStream);
                  return (
                    <div className="px-3 py-2 border-t border-slate-700/40">
                      <div className="flex items-center gap-1.5 text-[10px] text-emerald-400 font-medium mb-1.5">
                        <ArrowUpFromLine size={10} /> TX Channels
                      </div>
                      {hasSap ? (
                        <div className="space-y-0.5">
                          {txWithStreams.map(({ ch, chName, sapStream }) => (
                            <div key={`tx-${ch.id}`} className="flex items-center gap-1.5 text-[10px]">
                              <span className="text-slate-600 w-5 text-right shrink-0">{ch.id}</span>
                              <span className="text-slate-300 truncate flex-1">{chName}</span>
                              {sapStream && (
                                <div className="flex items-center gap-1 shrink-0">
                                  <span className="text-slate-500 font-mono">{sapStream.mcast}:{sapStream.port}</span>
                                  <span className="bg-slate-700 px-1 py-0.5 rounded text-slate-400">{sapStream.codec}</span>
                                  <span className="bg-slate-700 px-1 py-0.5 rounded text-slate-400">{sapStream.channels}ch</span>
                                  {sapStream.ptime && <span className="text-slate-600">{sapStream.ptime}ms</span>}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                          {txWithStreams.map(({ ch, chName }) => (
                            <div key={`tx-${ch.id}`} className="flex items-center gap-1.5 text-[10px] text-slate-300">
                              <span className="text-slate-600 w-5 text-right shrink-0">{ch.id}</span>
                              <span className="truncate">{chName}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* RX channel names + routing */}
                {(dd?.rxChannelNames?.length ?? 0) > 0 && (
                  <div className="px-3 py-2 border-t border-slate-700/40">
                    <div className="flex items-center gap-1.5 text-[10px] text-sky-400 font-medium mb-1.5">
                      <ArrowDownToLine size={10} /> RX Channels
                    </div>
                    <div className="space-y-1">
                      {dd!.rxChannelNames.map(ch => {
                        const statusColor =
                          ch.statusText === 'Subscribed'   ? 'text-emerald-400' :
                          ch.statusText === 'Dangling'     ? 'text-amber-400'   :
                          ch.statusText === 'Unresolved'   ? 'text-red-400'     :
                          'text-slate-600';
                        const key = routeKey(ip, ch.id);
                        const isPickerOpen = routingTarget?.rxIp === ip && routingTarget?.rxChannelId === ch.id;
                        const rStatus = routeStatus[key];

                        // Collect all TX sources from other Dante devices
                        const txSources = devices
                          .filter(d => d.ip !== ip && (d.txChannelNames?.length ?? 0) > 0)
                          .flatMap(d => d.txChannelNames!.map(tx => ({
                            deviceName: d.name || d.ip,
                            deviceIp: d.ip,
                            channelId: tx.id,
                            channelName: tx.name || `ch${tx.id}`,
                          })));

                        return (
                          <div key={`rx-${ch.id}`}>
                            {/* Channel row */}
                            <div className="flex items-center gap-1 text-[10px] group">
                              <span className="text-slate-600 w-5 text-right shrink-0">{ch.id}</span>
                              <span className={`text-slate-300 truncate flex-1 ${rStatus === 'ok' ? 'text-emerald-400' : rStatus === 'err' ? 'text-red-400' : ''}`}>
                                {ch.name || `ch${ch.id}`}
                              </span>
                              {ch.txHost && (
                                <span className="text-slate-500 truncate max-w-[70px]">
                                  ← {ch.txHost.replace(/\.local\.?$/, '')}
                                  {ch.txChannelName ? `/${ch.txChannelName}` : ''}
                                </span>
                              )}
                              <span className={`shrink-0 font-medium ${statusColor}`}>
                                {ch.statusText || (ch.subscribed ? 'Sub' : '—')}
                              </span>
                              {/* Route button */}
                              {dd?.isDante && txSources.length > 0 && (
                                <button
                                  onClick={e => startRoute(e, ip, ch.id, ch.name || `ch${ch.id}`)}
                                  className={`shrink-0 p-0.5 transition-colors ${
                                    isPickerOpen
                                      ? 'text-sky-400'
                                      : 'opacity-0 group-hover:opacity-100 text-slate-500 hover:text-sky-400'
                                  }`}
                                  title="Route this RX channel"
                                >
                                  <Link size={9} />
                                </button>
                              )}
                              {/* Unsubscribe button (only if subscribed) */}
                              {dd?.isDante && ch.subscribed && (
                                <button
                                  onClick={e => removeRoute(e, ip, ch.id)}
                                  className="shrink-0 p-0.5 opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 transition-colors"
                                  title="Unsubscribe"
                                >
                                  <Unlink size={9} />
                                </button>
                              )}
                            </div>

                            {/* TX picker dropdown */}
                            {isPickerOpen && (
                              <div className="mt-1 ml-6 rounded border border-sky-700/50 bg-slate-900 shadow-lg text-[10px] max-h-40 overflow-y-auto z-10">
                                <div className="px-2 py-1 text-sky-400 border-b border-sky-700/30 font-medium">
                                  Route "{routingTarget?.rxChannelName}" ←
                                </div>
                                {txSources.map((src, i) => (
                                  <button
                                    key={i}
                                    onClick={() => applyRoute(src.deviceName, src.channelName)}
                                    className="w-full text-left px-2 py-1 hover:bg-sky-900/40 text-slate-300 flex items-center gap-1.5"
                                  >
                                    <ArrowUpFromLine size={8} className="text-emerald-400 shrink-0" />
                                    <span className="truncate">{src.channelName}</span>
                                    <span className="text-slate-500 truncate">@ {src.deviceName}</span>
                                  </button>
                                ))}
                                {txSources.length === 0 && (
                                  <div className="px-2 py-1.5 text-slate-600">No TX sources available</div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* SAP streams list — shown for RAVENNA/AES67-only; hidden for Dante with txChannelNames (already shown above) */}
                {devStreams.length > 0 && !(dd?.isDante && (dd?.txChannelNames?.length ?? 0) > 0) && (
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
