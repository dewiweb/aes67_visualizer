import React, { useMemo } from 'react';
import { Stream, Device, DanteDevice } from '../types';
import { Server, Radio, Clock, Layers, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';

interface DevicePanelProps {
  streams: Stream[];
  danteDevices: DanteDevice[];
  t: Record<string, string>;
  onStreamClick?: (stream: Stream) => void;
}

/**
 * Aggregate streams by device IP
 */
function aggregateDevices(streams: Stream[]): Device[] {
  const deviceMap = new Map<string, Device>();

  for (const stream of streams) {
    // Use deviceIp (from SDP origin) or sapSourceIp as fallback
    const ip = stream.deviceIp || stream.sapSourceIp || 'unknown';
    
    if (!deviceMap.has(ip)) {
      deviceMap.set(ip, {
        ip,
        name: ip === 'unknown' ? 'Unknown Device' : ip,
        streams: [],
        streamCount: 0,
        channelCount: 0,
      });
    }

    const device = deviceMap.get(ip)!;
    device.streams.push(stream);
    device.streamCount++;
    device.channelCount += stream.channels || 0;

    // Aggregate device info from streams
    if (stream.ptpGrandmaster && !device.ptpGrandmaster) {
      device.ptpGrandmaster = stream.ptpGrandmaster;
      device.ptpVersion = stream.ptpVersion;
      device.ptpDomain = stream.ptpDomain;
    }
    if (stream.tool && !device.tool) {
      device.tool = stream.tool;
    }
  }

  return Array.from(deviceMap.values()).sort((a, b) => a.ip.localeCompare(b.ip));
}

const DevicePanel: React.FC<DevicePanelProps> = ({ streams, danteDevices, t, onStreamClick }) => {
  const [expandedDevices, setExpandedDevices] = React.useState<Set<string>>(new Set());

  const devices = useMemo(() => aggregateDevices(streams), [streams]);

  const toggleDevice = (ip: string) => {
    setExpandedDevices(prev => {
      const next = new Set(prev);
      if (next.has(ip)) {
        next.delete(ip);
      } else {
        next.add(ip);
      }
      return next;
    });
  };

  if (devices.length === 0 && danteDevices.length === 0) {
    return (
      <div className="p-4 text-slate-500 text-sm text-center">
        {t.noDevices || 'No devices detected'}
      </div>
    );
  }

  return (
    <div className="space-y-2 p-2">

      {/* Dante/RAVENNA devices discovered via ARC probe or mDNS */}
      {danteDevices.map((dd) => {
        const ip = dd.addresses.find(a => a.includes('.')) || dd.host;
        // Check if this IP also has SAP streams
        const sapDevice = devices.find(d => d.ip === ip);
        return (
          <div
            key={dd.host}
            className="bg-slate-800 rounded-lg overflow-hidden border border-purple-900/40"
          >
            <div className="flex items-center gap-3 p-3">
              <Server size={18} className="text-purple-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm text-white truncate">
                    {dd.name || ip}
                  </span>
                  {dd.isRAVENNA ? (
                    <span className="text-[10px] bg-teal-900/50 text-teal-300 px-1.5 py-0.5 rounded">RAVENNA</span>
                  ) : (
                    <span className="text-[10px] bg-purple-900/50 text-purple-300 px-1.5 py-0.5 rounded">Dante</span>
                  )}
                  {dd.isAES67 && (
                    <span className="text-[10px] bg-blue-900/50 text-blue-300 px-1.5 py-0.5 rounded">AES67</span>
                  )}
                  {sapDevice && (
                    <span className="text-[10px] bg-green-900/50 text-green-300 px-1.5 py-0.5 rounded">
                      {sapDevice.streamCount} streams
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-400 mt-0.5 flex-wrap">
                  <span className="font-mono text-slate-500">{ip}</span>
                  {dd.model && (
                    <span className="text-slate-500">{dd.model}</span>
                  )}
                  {dd.txChannels != null && (
                    <span className="flex items-center gap-1 text-emerald-400">
                      <Layers size={10} />
                      {dd.txChannels} TX
                    </span>
                  )}
                  {dd.rxChannels != null && (
                    <span className="flex items-center gap-1 text-sky-400">
                      <Layers size={10} />
                      {dd.rxChannels} RX
                    </span>
                  )}
                  {dd.sampleRate && (
                    <span>{dd.sampleRate / 1000}kHz</span>
                  )}
                </div>
                {dd.requiresAES67 && (
                  <div className="flex items-center gap-1 mt-1 text-[10px] text-yellow-500">
                    <AlertCircle size={10} />
                    <span>Enable AES67 on device to stream</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* SAP-based devices */}
      {devices.map((device) => {
        const isExpanded = expandedDevices.has(device.ip);
        
        return (
          <div
            key={device.ip}
            className="bg-slate-800 rounded-lg overflow-hidden"
          >
            {/* Device Header */}
            <button
              onClick={() => toggleDevice(device.ip)}
              className="w-full flex items-center gap-3 p-3 hover:bg-slate-700/50 transition-colors text-left"
            >
              <Server size={18} className="text-blue-400 shrink-0" />
              
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm text-white truncate">
                    {device.ip}
                  </span>
                  {device.tool && (
                    <span className="text-xs text-slate-400 truncate">
                      ({device.tool})
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-400 mt-0.5">
                  <span className="flex items-center gap-1">
                    <Radio size={10} />
                    {device.streamCount} {t.streams || 'streams'}
                  </span>
                  <span className="flex items-center gap-1">
                    <Layers size={10} />
                    {device.channelCount} ch
                  </span>
                </div>
              </div>

              {isExpanded ? (
                <ChevronDown size={16} className="text-slate-400" />
              ) : (
                <ChevronRight size={16} className="text-slate-400" />
              )}
            </button>

            {/* Expanded Device Info */}
            {isExpanded && (
              <div className="border-t border-slate-700">
                {/* PTP Info */}
                {device.ptpGrandmaster && (
                  <div className="px-3 py-2 bg-slate-900/50">
                    <div className="flex items-center gap-2 text-xs">
                      <Clock size={12} className="text-green-400" />
                      <span className="text-slate-400">PTP:</span>
                      <span className="text-green-300 font-mono text-[10px]">
                        {device.ptpGrandmaster}
                      </span>
                    </div>
                    <div className="flex gap-4 mt-1 text-[10px] text-slate-500 ml-5">
                      {device.ptpVersion && (
                        <span>{device.ptpVersion}</span>
                      )}
                      {device.ptpDomain && (
                        <span>Domain: {device.ptpDomain}</span>
                      )}
                    </div>
                  </div>
                )}

                {/* Streams List */}
                <div className="divide-y divide-slate-700/50">
                  {device.streams.map((stream) => (
                    <div
                      key={stream.id}
                      onClick={() => onStreamClick?.(stream)}
                      className="px-3 py-2 hover:bg-slate-700/30 cursor-pointer transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-slate-300 truncate">
                          {stream.name}
                        </span>
                        <div className="flex items-center gap-1 text-[10px]">
                          <span className="bg-slate-700 px-1.5 py-0.5 rounded text-slate-300">
                            {stream.codec}
                          </span>
                          <span className="bg-slate-700 px-1.5 py-0.5 rounded text-slate-300">
                            {stream.channels}ch
                          </span>
                          {stream.redundant && (
                            <span className="bg-orange-900/50 px-1.5 py-0.5 rounded text-orange-300">
                              ST2022-7
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-[10px] text-slate-500 mt-0.5">
                        {stream.mcast}:{stream.port}
                        {stream.info && (
                          <span className="ml-2 text-slate-600">• {stream.info}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default DevicePanel;
