import React, { useState } from 'react';
import { Plus, Radio, FileText, Server } from 'lucide-react';
import { Stream, StreamLevels } from '../types';
import StreamCard from './StreamCard';
import DevicePanel from './DevicePanel';

type TabType = 'streams' | 'devices' | 'manual';

interface SidebarProps {
  t: Record<string, string>;
  streams: Stream[];
  streamLevels: StreamLevels;
  playingStreamId: string | null;
  onAddManualStream: (sdp: string) => void;
  onRemoveStream: (streamId: string) => void;
  onPlayStream: (stream: Stream, ch1: number, ch2: number) => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  t,
  streams,
  streamLevels,
  playingStreamId,
  onAddManualStream,
  onRemoveStream,
  onPlayStream,
}) => {
  const [activeTab, setActiveTab] = useState<TabType>('streams');
  const [sdpInput, setSdpInput] = useState('');

  const handleAddSdp = () => {
    if (sdpInput.trim()) {
      onAddManualStream(sdpInput.trim());
      setSdpInput('');
    }
  };

  const sapStreams = streams.filter((s) => s.sourceType === 'sap' || s.sourceType === 'dante');
  const manualStreams = streams.filter((s) => s.sourceType === 'manual');

  // Count unique devices
  const deviceCount = new Set(streams.map(s => s.deviceIp || s.sapSourceIp || 'unknown')).size;

  return (
    <aside className="w-80 bg-slate-800 border-r border-slate-700 flex flex-col shrink-0 overflow-hidden">
      {/* Tab Navigation */}
      <div className="flex border-b border-slate-700">
        <button
          onClick={() => setActiveTab('streams')}
          className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-medium transition-colors ${
            activeTab === 'streams'
              ? 'bg-slate-700 text-white border-b-2 border-blue-500'
              : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
          }`}
        >
          <Radio size={14} />
          <span>{t.streams || 'Streams'}</span>
          <span className="text-xs bg-slate-600 px-1.5 py-0.5 rounded-full">
            {sapStreams.length}
          </span>
        </button>
        <button
          onClick={() => setActiveTab('devices')}
          className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-medium transition-colors ${
            activeTab === 'devices'
              ? 'bg-slate-700 text-white border-b-2 border-blue-500'
              : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
          }`}
        >
          <Server size={14} />
          <span>{t.devices || 'Devices'}</span>
          <span className="text-xs bg-slate-600 px-1.5 py-0.5 rounded-full">
            {deviceCount}
          </span>
        </button>
        <button
          onClick={() => setActiveTab('manual')}
          className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-medium transition-colors ${
            activeTab === 'manual'
              ? 'bg-slate-700 text-white border-b-2 border-blue-500'
              : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
          }`}
        >
          <FileText size={14} />
          <span>SDP</span>
          {manualStreams.length > 0 && (
            <span className="text-xs bg-slate-600 px-1.5 py-0.5 rounded-full">
              {manualStreams.length}
            </span>
          )}
        </button>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Streams Tab */}
        {activeTab === 'streams' && (
          <div className="p-2 space-y-2">
            {sapStreams.length === 0 ? (
              <div className="text-center py-8 text-slate-500 text-sm">
                <Radio size={32} className="mx-auto mb-2 opacity-50" />
                <p>{t.noStreams}</p>
                <p className="text-xs mt-1">{t.waitingForStreams}</p>
              </div>
            ) : (
              sapStreams.map((stream) => (
                <StreamCard
                  key={stream.id}
                  stream={stream}
                  levels={streamLevels[stream.id]}
                  isPlaying={playingStreamId === stream.id}
                  onPlay={(ch1, ch2) => onPlayStream(stream, ch1, ch2)}
                  onRemove={() => onRemoveStream(stream.id)}
                  draggable
                />
              ))
            )}
          </div>
        )}

        {/* Devices Tab */}
        {activeTab === 'devices' && (
          <DevicePanel
            streams={streams}
            t={t}
            onStreamClick={(stream) => onPlayStream(stream, 0, Math.min(1, stream.channels - 1))}
          />
        )}

        {/* Manual SDP Tab */}
        {activeTab === 'manual' && (
          <div className="p-3 space-y-3">
            {/* Manual streams list */}
            {manualStreams.length > 0 && (
              <div className="space-y-2 mb-3">
                {manualStreams.map((stream) => (
                  <StreamCard
                    key={stream.id}
                    stream={stream}
                    levels={streamLevels[stream.id]}
                    isPlaying={playingStreamId === stream.id}
                    onPlay={(ch1, ch2) => onPlayStream(stream, ch1, ch2)}
                    onRemove={() => onRemoveStream(stream.id)}
                    draggable
                  />
                ))}
              </div>
            )}

            {/* SDP Input */}
            <textarea
              value={sdpInput}
              onChange={(e) => setSdpInput(e.target.value)}
              placeholder={t.pasteSdp}
              className="w-full h-32 bg-slate-900 border border-slate-600 rounded-lg p-2 text-xs font-mono text-slate-300 resize-none focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={handleAddSdp}
              disabled={!sdpInput.trim()}
              className="w-full flex items-center justify-center gap-2 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
            >
              <Plus size={16} />
              {t.addStream}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
};

export default Sidebar;
