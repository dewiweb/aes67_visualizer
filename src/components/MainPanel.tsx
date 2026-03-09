import React, { useState } from 'react';
import { Plus, Download } from 'lucide-react';
import { ViewId } from '../App';
import {
  Stream, StreamLevels, StreamPtpStatuses,
  DanteDevice, PtpClock, MonitorSlot, PortConflictData,
} from '../types';
import StreamCard from './StreamCard';
import MonitoringWall from './MonitoringWall';
import DevicePanel from './DevicePanel';
import PtpPanel from './PtpPanel';
import PermissionsPanel from './PermissionsPanel';

interface MainPanelProps {
  activeView: ViewId;
  t: Record<string, string>;
  streams: Stream[];
  streamLevels: StreamLevels;
  streamPtpStatuses: StreamPtpStatuses;
  danteDevices: DanteDevice[];
  ptpClocks: PtpClock[];
  slots: MonitorSlot[];
  playingStreamId: string | null;
  portConflicts: PortConflictData[];
  onAddManualStream: (sdp: string) => void;
  onRemoveStream: (streamId: string) => void;
  onPlayStream: (stream: Stream, ch1: number, ch2: number) => void;
  onExportJson: () => void;
  onRemoveFromSlot: (slotId: string) => void;
}

const MainPanel: React.FC<MainPanelProps> = ({
  activeView,
  t,
  streams,
  streamLevels,
  streamPtpStatuses,
  danteDevices,
  ptpClocks,
  slots,
  playingStreamId,
  portConflicts,
  onAddManualStream,
  onRemoveStream,
  onPlayStream,
  onExportJson,
  onRemoveFromSlot,
}) => {
  const [sdpInput, setSdpInput] = useState('');

  const sapStreams  = streams.filter(s => s.sourceType === 'sap');
  const manualStreams = streams.filter(s => s.sourceType === 'manual');

  const handleAddSdp = () => {
    if (sdpInput.trim()) {
      onAddManualStream(sdpInput.trim());
      setSdpInput('');
    }
  };

  // ── Monitoring view: stream list (left panel) + wall (right) ────────────────
  if (activeView === 'monitoring') {
    return (
      <div className="flex-1 flex overflow-hidden">
        {/* Left: stream list */}
        <div className="w-72 shrink-0 bg-slate-800 border-r border-slate-700 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700">
            <h2 className="text-sm font-semibold text-slate-200">
              {t.streams || 'Streams'}
              {sapStreams.length > 0 && (
                <span className="ml-2 text-xs font-normal text-slate-500">{sapStreams.length}</span>
              )}
            </h2>
            <button
              onClick={onExportJson}
              disabled={streams.length === 0}
              title="Export JSON"
              className="p-1 text-slate-500 hover:text-slate-300 disabled:opacity-30 transition-colors"
            >
              <Download size={14} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {sapStreams.length === 0 ? (
              <div className="text-center py-10 text-slate-500 text-sm">
                <div className="text-3xl mb-2 opacity-40">📡</div>
                <p>{t.noStreams || 'No streams detected'}</p>
                <p className="text-xs mt-1 text-slate-600">{t.waitingForStreams || 'Waiting for SAP...'}</p>
              </div>
            ) : (
              sapStreams.map(stream => (
                <StreamCard
                  key={stream.id}
                  stream={stream}
                  levels={streamLevels[stream.id]}
                  ptpStatus={streamPtpStatuses[stream.id]}
                  isPlaying={playingStreamId === stream.id}
                  onPlay={(ch1, ch2) => onPlayStream(stream, ch1, ch2)}
                  onRemove={() => onRemoveStream(stream.id)}
                  draggable
                />
              ))
            )}
          </div>
        </div>

        {/* Right: monitoring wall */}
        <MonitoringWall
          t={t}
          slots={slots}
          streamLevels={streamLevels}
          streamPtpStatuses={streamPtpStatuses}
          onRemoveFromSlot={onRemoveFromSlot}
        />
      </div>
    );
  }

  // ── Devices view: full-width DevicePanel ─────────────────────────────────────
  if (activeView === 'devices') {
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-slate-900">
        <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between shrink-0">
          <h2 className="text-base font-semibold text-white">
            {t.devices || 'Devices'}
          </h2>
          <span className="text-xs text-slate-500">
            {new Set([
              ...danteDevices.map(d => d.ip).filter(Boolean),
              ...streams.map(s => s.deviceIp || s.sapSourceIp).filter(Boolean),
            ]).size} {t.devices || 'devices'}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          <DevicePanel
            streams={streams}
            danteDevices={danteDevices}
            t={t}
            onStreamClick={(stream) => onPlayStream(stream, 0, Math.min(1, stream.channels - 1))}
          />
        </div>
      </div>
    );
  }

  // ── PTP view: full-width PtpPanel ─────────────────────────────────────────────
  if (activeView === 'ptp') {
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-slate-900">
        <div className="px-4 py-3 border-b border-slate-700 shrink-0">
          <h2 className="text-base font-semibold text-white">PTP — IEEE 1588</h2>
        </div>
        <div className="flex-1 overflow-y-auto">
          <PtpPanel clocks={ptpClocks} />
        </div>
      </div>
    );
  }

  // ── SDP view: manual SDP input + manual streams ───────────────────────────────
  if (activeView === 'sdp') {
    return (
      <div className="flex-1 flex overflow-hidden bg-slate-900">
        {/* Manual streams list */}
        <div className="w-80 shrink-0 bg-slate-800 border-r border-slate-700 flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-700">
            <h2 className="text-sm font-semibold text-slate-200">
              {t.manualSdp || 'Manual SDP'}
              {manualStreams.length > 0 && (
                <span className="ml-2 text-xs font-normal text-slate-500">{manualStreams.length}</span>
              )}
            </h2>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {manualStreams.length === 0 ? (
              <p className="text-center py-8 text-slate-600 text-sm">No manual streams</p>
            ) : (
              manualStreams.map(stream => (
                <StreamCard
                  key={stream.id}
                  stream={stream}
                  levels={streamLevels[stream.id]}
                  ptpStatus={streamPtpStatuses[stream.id]}
                  isPlaying={playingStreamId === stream.id}
                  onPlay={(ch1, ch2) => onPlayStream(stream, ch1, ch2)}
                  onRemove={() => onRemoveStream(stream.id)}
                  draggable
                />
              ))
            )}
          </div>
        </div>

        {/* Right: SDP paste area */}
        <div className="flex-1 flex flex-col p-6 gap-4 overflow-auto">
          <div>
            <h3 className="text-sm font-semibold text-slate-200 mb-1">{t.pasteSdp || 'Paste SDP'}</h3>
            <p className="text-xs text-slate-500 mb-3">
              Paste a raw SDP (Session Description Protocol) block to add a stream manually.
              The stream will be announced on the network via SAP every 30s.
            </p>
          </div>

          <textarea
            value={sdpInput}
            onChange={e => setSdpInput(e.target.value)}
            placeholder={`v=0\r\no=- 1234567890 1234567890 IN IP4 192.168.1.1\r\ns=My Stream\r\n...`}
            className="flex-1 min-h-[200px] bg-slate-800 border border-slate-600 rounded-lg p-3 text-xs font-mono text-slate-300 resize-none focus:outline-none focus:border-blue-500"
            spellCheck={false}
          />

          <button
            onClick={handleAddSdp}
            disabled={!sdpInput.trim()}
            className="flex items-center justify-center gap-2 py-2.5 px-4 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors self-start"
          >
            <Plus size={16} />
            {t.addStream || 'Add Stream'}
          </button>
        </div>
      </div>
    );
  }

  // ── Permissions view ──────────────────────────────────────────────────────────
  if (activeView === 'permissions') {
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-slate-900">
        <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between shrink-0">
          <h2 className="text-base font-semibold text-white">Permissions & Network Access</h2>
          {portConflicts.length > 0 && (
            <span className="text-xs text-red-400">{portConflicts.length} active issue{portConflicts.length > 1 ? 's' : ''}</span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          <PermissionsPanel portConflicts={portConflicts} />
        </div>
      </div>
    );
  }

  return null;
};

export default MainPanel;
