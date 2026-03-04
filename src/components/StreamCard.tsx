import React, { useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { Play, Square, Trash2, Radio, FileText, GripVertical } from 'lucide-react';
import { Stream, ChannelLevel } from '../types';
import LevelMeter from './LevelMeter';

interface StreamCardProps {
  stream: Stream;
  levels?: ChannelLevel[];
  isPlaying?: boolean;
  isDragging?: boolean;
  draggable?: boolean;
  onPlay?: (ch1: number, ch2: number) => void;
  onRemove?: () => void;
}

const StreamCard: React.FC<StreamCardProps> = ({
  stream,
  levels,
  isPlaying = false,
  isDragging = false,
  draggable = false,
  onPlay,
  onRemove,
}) => {
  const [selectedChannels, setSelectedChannels] = useState<[number, number]>([0, 1]);

  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: stream.id,
    disabled: !draggable || !stream.isSupported,
  });

  const style = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
      }
    : undefined;

  const handlePlay = () => {
    if (onPlay) {
      onPlay(selectedChannels[0], selectedChannels[1]);
    }
  };

  // Generate channel options
  const channelOptions: { value: string; label: string }[] = [];
  
  // Stereo pairs
  for (let i = 0; i < stream.channels - 1; i += 2) {
    channelOptions.push({
      value: `${i},${i + 1}`,
      label: `${i + 1}-${i + 2} Stereo`,
    });
  }
  
  // Mono channels
  for (let i = 0; i < stream.channels; i++) {
    channelOptions.push({
      value: `${i},${i}`,
      label: `${i + 1} Mono`,
    });
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`
        bg-slate-900 rounded-lg border transition-all
        ${stream.isSupported ? 'border-slate-700 hover:border-slate-600' : 'border-red-900/50 opacity-60'}
        ${isDragging ? 'shadow-xl scale-105' : ''}
        ${isPlaying ? 'border-green-500/50 ring-1 ring-green-500/30' : ''}
      `}
    >
      {/* Header */}
      <div className="flex items-center gap-2 p-2 border-b border-slate-700/50">
        {draggable && stream.isSupported && (
          <div
            {...attributes}
            {...listeners}
            className="cursor-grab active:cursor-grabbing p-1 hover:bg-slate-700 rounded"
          >
            <GripVertical size={14} className="text-slate-500" />
          </div>
        )}
        
        {stream.sourceType === 'sap' ? (
          <Radio size={14} className="text-blue-400 shrink-0" />
        ) : stream.sourceType === 'dante' ? (
          <Radio size={14} className="text-purple-400 shrink-0" />
        ) : (
          <FileText size={14} className="text-green-400 shrink-0" />
        )}
        
        <span className="font-medium text-sm truncate flex-1" title={stream.name}>
          {stream.name}
        </span>

        {isPlaying && (
          <span className="text-xs text-green-400 animate-pulse">●</span>
        )}
      </div>

      {/* Info */}
      <div className="p-2 space-y-2">
        <div className="flex flex-wrap gap-1 text-xs">
          <span className="bg-slate-700 px-1.5 py-0.5 rounded text-slate-300">
            {stream.codec}
          </span>
          <span className="bg-slate-700 px-1.5 py-0.5 rounded text-slate-300">
            {stream.sampleRate / 1000}kHz
          </span>
          <span className="bg-slate-700 px-1.5 py-0.5 rounded text-slate-300">
            {stream.channels}ch
          </span>
          {stream.dante && (
            <span className="bg-purple-900/50 px-1.5 py-0.5 rounded text-purple-300">
              Dante
            </span>
          )}
          {stream.danteDevice?.isAES67 && (
            <span className="bg-blue-900/50 px-1.5 py-0.5 rounded text-blue-300">
              AES67
            </span>
          )}
          {stream.requiresSubscription && (
            <span className="bg-yellow-900/50 px-1.5 py-0.5 rounded text-yellow-300">
              ⚠ Sub
            </span>
          )}
        </div>

        <div className="text-xs text-slate-500 truncate" title={stream.mcast}>
          {stream.mcast}:{stream.port}
        </div>

        {/* Level meters (show selected channels) */}
        {levels && levels.length > 0 && (
          <div className="flex gap-1 h-4">
            {selectedChannels[0] === selectedChannels[1] ? (
              // Mono: show single channel
              <LevelMeter
                key={selectedChannels[0]}
                current={levels[selectedChannels[0]]?.current ?? -100}
                peak={levels[selectedChannels[0]]?.peak ?? -100}
                className="flex-1"
              />
            ) : (
              // Stereo: show both selected channels
              <>
                <LevelMeter
                  key={selectedChannels[0]}
                  current={levels[selectedChannels[0]]?.current ?? -100}
                  peak={levels[selectedChannels[0]]?.peak ?? -100}
                  className="flex-1"
                />
                <LevelMeter
                  key={selectedChannels[1]}
                  current={levels[selectedChannels[1]]?.current ?? -100}
                  peak={levels[selectedChannels[1]]?.peak ?? -100}
                  className="flex-1"
                />
              </>
            )}
          </div>
        )}

        {/* Controls */}
        {stream.isSupported && (onPlay || onRemove) && (
          <div className="flex items-center gap-2 pt-1">
            {onPlay && stream.channels > 2 && (
              <select
                value={`${selectedChannels[0]},${selectedChannels[1]}`}
                onChange={(e) => {
                  const [ch1, ch2] = e.target.value.split(',').map(Number);
                  setSelectedChannels([ch1, ch2]);
                }}
                className="flex-1 bg-slate-700 text-xs rounded px-1.5 py-1 border border-slate-600 focus:outline-none focus:border-blue-500"
              >
                {channelOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            )}

            {onPlay && (
              <button
                onClick={handlePlay}
                className={`p-1.5 rounded transition-colors ${
                  isPlaying
                    ? 'bg-red-600 hover:bg-red-500'
                    : 'bg-green-600 hover:bg-green-500'
                }`}
                title={isPlaying ? 'Stop' : 'Play'}
              >
                {isPlaying ? <Square size={14} /> : <Play size={14} />}
              </button>
            )}

            {onRemove && stream.manual && (
              <button
                onClick={onRemove}
                className="p-1.5 rounded bg-slate-700 hover:bg-red-600 transition-colors"
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        )}

        {/* Unsupported reason */}
        {!stream.isSupported && stream.unsupportedReason && (
          <div className="text-xs text-red-400">
            {stream.unsupportedReason}
          </div>
        )}
      </div>
    </div>
  );
};

export default StreamCard;
