import React, { useState, useMemo } from 'react';
import { Plus, Download, X, Pencil, Search, Radio } from 'lucide-react';
import { ViewId } from '../App';
import {
  Stream, StreamLevels, StreamPtpStatuses,
  NetworkDevice, PtpClock, MonitorSlot, PortConflictData,
} from '../types';
import StreamCard from './StreamCard';
import MonitoringWall from './MonitoringWall';
import DevicePanel from './DevicePanel';
import PtpPanel from './PtpPanel';
import PermissionsPanel from './PermissionsPanel';
import RoutingMatrix from './RoutingMatrix';

interface MainPanelProps {
  activeView: ViewId;
  t: Record<string, string>;
  streams: Stream[];
  streamLevels: StreamLevels;
  streamPtpStatuses: StreamPtpStatuses;
  devices: NetworkDevice[];
  ptpClocks: PtpClock[];
  slots: MonitorSlot[];
  gridCols: number;
  playingStreamId: string | null;
  portConflicts: PortConflictData[];
  mdnsError: { code: string; message: string } | null;
  onAddManualStream: (sdp: string) => void;
  onRemoveStream: (streamId: string) => void;
  onEditManualStream: (streamId: string, sdp: string) => void;
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
  devices,
  ptpClocks,
  slots,
  gridCols,
  playingStreamId,
  portConflicts,
  mdnsError,
  onAddManualStream,
  onRemoveStream,
  onEditManualStream,
  onPlayStream,
  onExportJson,
  onRemoveFromSlot,
}) => {
  const [sdpInput, setSdpInput] = useState('');
  const [showSdpModal, setShowSdpModal] = useState(false);
  const [editingStreamId, setEditingStreamId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const sapStreams  = useMemo(() => streams.filter(s => s.sourceType === 'sap'), [streams]);
  const manualStreams = useMemo(() => streams.filter(s => s.sourceType === 'manual'), [streams]);

  const filterFn = (s: Stream) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return s.name?.toLowerCase().includes(q)
      || s.mcast?.toLowerCase().includes(q)
      || s.codec?.toLowerCase().includes(q)
      || s.streamFamily?.toLowerCase().includes(q);
  };

  const filteredSap = sapStreams.filter(filterFn);
  const filteredManual = manualStreams.filter(filterFn);

  // Stream IDs currently in wall slots — hide their meters in the list to avoid duplication
  const slottedStreamIds = new Set(slots.filter(s => s.stream).map(s => s.stream!.id));

  const handleAddSdp = () => {
    if (sdpInput.trim()) {
      if (editingStreamId) {
        onEditManualStream(editingStreamId, sdpInput.trim());
      } else {
        onAddManualStream(sdpInput.trim());
      }
      setSdpInput('');
      setShowSdpModal(false);
      setEditingStreamId(null);
    }
  };

  const handleEditStream = (stream: Stream) => {
    setEditingStreamId(stream.id);
    setSdpInput(stream.raw || '');
    setShowSdpModal(true);
  };

  const handleCloseModal = () => {
    setShowSdpModal(false);
    setSdpInput('');
    setEditingStreamId(null);
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
              {streams.length > 0 && (
                <span className="ml-2 text-xs font-normal text-slate-500">{streams.length}</span>
              )}
            </h2>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setShowSdpModal(true)}
                title={t.addStream || 'Add Stream'}
                className="p-1 text-slate-500 hover:text-green-400 transition-colors"
              >
                <Plus size={16} />
              </button>
              <button
                onClick={onExportJson}
                disabled={streams.length === 0}
                title={t.exportJson || 'Export JSON'}
                className="p-1 text-slate-500 hover:text-slate-300 disabled:opacity-30 transition-colors"
              >
                <Download size={14} />
              </button>
            </div>
          </div>
          {/* Search filter */}
          {streams.length > 3 && (
            <div className="px-3 py-2 border-b border-slate-700">
              <div className="relative">
                <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t.search || 'Search...'}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg pl-7 pr-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
          )}
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {filteredSap.length === 0 && filteredManual.length === 0 ? (
              <div className="text-center py-10 text-slate-500 text-sm">
                <Radio size={32} className="mx-auto mb-2 opacity-30" />
                <p>{t.noStreams || 'No streams detected'}</p>
                <p className="text-xs mt-1 text-slate-600">{t.waitingForStreams || 'Waiting for SAP...'}</p>
              </div>
            ) : (
              <>
                {filteredSap.map(stream => (
                  <StreamCard
                    key={stream.id}
                    stream={stream}
                    levels={slottedStreamIds.has(stream.id) ? undefined : streamLevels[stream.id]}
                    ptpStatus={streamPtpStatuses[stream.id]}
                    isPlaying={playingStreamId === stream.id}
                    onPlay={(ch1, ch2) => onPlayStream(stream, ch1, ch2)}
                    onRemove={() => onRemoveStream(stream.id)}
                    draggable
                  />
                ))}
                {filteredManual.length > 0 && (
                  <>
                    <div className="pt-2 pb-1 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                      {t.manual || 'Manual'}
                    </div>
                    {filteredManual.map(stream => (
                      <StreamCard
                        key={stream.id}
                        stream={stream}
                        levels={slottedStreamIds.has(stream.id) ? undefined : streamLevels[stream.id]}
                        ptpStatus={streamPtpStatuses[stream.id]}
                        isPlaying={playingStreamId === stream.id}
                        onPlay={(ch1, ch2) => onPlayStream(stream, ch1, ch2)}
                        onRemove={() => onRemoveStream(stream.id)}
                        onEdit={() => handleEditStream(stream)}
                        draggable
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right: monitoring wall */}
        <MonitoringWall
          t={t}
          slots={slots}
          gridCols={gridCols}
          streamLevels={streamLevels}
          streamPtpStatuses={streamPtpStatuses}
          onRemoveFromSlot={onRemoveFromSlot}
        />

        {/* SDP modal */}
        {showSdpModal && (
          <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
            onClick={handleCloseModal}
          >
            <div
              className="bg-slate-800 rounded-xl border border-slate-700 w-full max-w-lg shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
                <h2 className="text-sm font-semibold text-slate-200">
                  {editingStreamId
                    ? (t.editSdp || 'Edit SDP')
                    : (t.pasteSdp || 'Paste SDP')}
                </h2>
                <button
                  onClick={handleCloseModal}
                  className="p-1 rounded hover:bg-slate-700 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="p-4 space-y-3">
                <p className="text-xs text-slate-500">
                  {editingStreamId
                    ? (t.editSdpDesc || 'Edit the SDP of this manual stream. The old stream will be replaced.')
                    : (t.sdpModalDesc || 'Paste a raw SDP block to add a stream manually. Manual streams are saved between sessions and can be dragged to the monitoring wall.')}
                </p>
                <textarea
                  value={sdpInput}
                  onChange={(e) => setSdpInput(e.target.value)}
                  placeholder={`v=0\r\no=- 1234567890 1234567890 IN IP4 192.168.1.1\r\ns=My Stream\r\nc=IN IP4 230.0.0.1\r\nm=audio 5004 RTP/AVP 96\r\n...`}
                  className="w-full min-h-[200px] bg-slate-900 border border-slate-600 rounded-lg p-3 text-xs font-mono text-slate-300 resize-none focus:outline-none focus:border-blue-500"
                  spellCheck={false}
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  <button
                    onClick={handleCloseModal}
                    className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
                  >
                    {t.cancel || 'Cancel'}
                  </button>
                  <button
                    onClick={handleAddSdp}
                    disabled={!sdpInput.trim()}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
                  >
                    {editingStreamId ? <Pencil size={16} /> : <Plus size={16} />}
                    {editingStreamId
                      ? (t.save || 'Save')
                      : (t.addStream || 'Add Stream')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
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
              ...devices.map(d => d.ip).filter(Boolean),
              ...streams.map(s => s.deviceIp || s.sapSourceIp).filter(Boolean),
            ]).size} {t.devices || 'devices'}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          <DevicePanel
            streams={streams}
            devices={devices}
            t={t}
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
          <PtpPanel clocks={ptpClocks} allDevices={devices} />
        </div>
      </div>
    );
  }

  // ── Routing Matrix view (Dante only) ───────────────────────────────────────
  if (activeView === 'routing') {
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-slate-900">
        <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between shrink-0">
          <h2 className="text-base font-semibold text-white">Dante Routing Matrix</h2>
          <span className="text-xs text-slate-500">Dante devices only — TX × RX crosspoint</span>
        </div>
        <RoutingMatrix devices={devices} />
      </div>
    );
  }

  // ── Permissions view ──────────────────────────────────────────────
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
          <PermissionsPanel portConflicts={portConflicts} mdnsError={mdnsError} />
        </div>
      </div>
    );
  }

  return null;
};

export default MainPanel;
