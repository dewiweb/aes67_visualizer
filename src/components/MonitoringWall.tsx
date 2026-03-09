import React from 'react';
import { useDroppable } from '@dnd-kit/core';
import { X, Radio } from 'lucide-react';
import { MonitorSlot, StreamLevels, StreamPtpStatuses, ChannelLevel, PtpStatus } from '../types';
import LevelMeter from './LevelMeter';

interface MonitoringWallProps {
  t: Record<string, string>;
  slots: MonitorSlot[];
  streamLevels: StreamLevels;
  streamPtpStatuses: StreamPtpStatuses;
  onRemoveFromSlot: (slotId: string) => void;
}

interface SlotProps {
  slot: MonitorSlot;
  levels?: ChannelLevel[];
  ptpStatus?: PtpStatus | null;
  t: Record<string, string>;
  onRemove: () => void;
}

const PTP_DOT_CLS: Record<string, string> = {
  locked:   'bg-green-400',
  degraded: 'bg-yellow-400 animate-pulse',
  unlocked: 'bg-red-400 animate-pulse',
  unknown:  'bg-slate-500',
};

const MonitorSlotComponent: React.FC<SlotProps> = ({ slot, levels, ptpStatus, t, onRemove }) => {
  const { isOver, setNodeRef } = useDroppable({
    id: slot.id,
  });

  const hasStream = slot.stream !== null;

  return (
    <div
      ref={setNodeRef}
      className={`
        relative rounded-xl border-2 transition-all duration-200 overflow-hidden
        ${hasStream 
          ? 'bg-slate-800 border-slate-600' 
          : 'bg-slate-800/50 border-dashed border-slate-700'
        }
        ${isOver ? 'border-blue-500 bg-blue-500/10 scale-[1.02]' : ''}
      `}
    >
      {hasStream && slot.stream ? (
        <>
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 bg-slate-900/50 border-b border-slate-700">
            <div className="flex items-center gap-2 min-w-0">
              <Radio size={14} className="text-blue-400 shrink-0" />
              <span className="font-medium text-sm truncate">{slot.stream.name}</span>
              {ptpStatus && (
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${PTP_DOT_CLS[ptpStatus.lockStatus] || PTP_DOT_CLS.unknown}`}
                  title={`PTP: ${ptpStatus.lockStatus} — ${ptpStatus.driftPpm} ppm`}
                />
              )}
            </div>
            <button
              onClick={onRemove}
              className="p-1 rounded hover:bg-red-500/20 text-slate-500 hover:text-red-400 transition-colors shrink-0"
              title={t.remove}
            >
              <X size={14} />
            </button>
          </div>

          {/* Meters */}
          {(() => {
            const chCount = slot.stream.channels || 2;
            const compact  = chCount > 4; // thin bars, no per-channel labels
            const activeLevels = levels && levels.length > 0 ? levels
              : Array.from({ length: chCount }, () => ({ current: -100, peak: -100, lufs: undefined }));

            // Single LUFS value: max across channels (most prominent signal)
            const lufsValues = activeLevels.map(l => l.lufs ?? -100).filter(v => v > -100);
            const lufsMax = lufsValues.length > 0 ? Math.max(...lufsValues) : null;

            return (
              <div className="p-3">
                <div className={`flex h-28 justify-center ${compact ? 'gap-0.5' : 'gap-2'}`}>
                  {activeLevels.map((level, i) => (
                    <div key={i} className={`flex flex-col items-center ${compact ? 'gap-0' : 'gap-1'}`}>
                      <LevelMeter
                        current={level.current}
                        peak={level.peak}
                        vertical
                        showLabels={!compact}
                        className="h-full"
                      />
                      {!compact && (
                        <span className="text-[10px] text-slate-500">{i + 1}</span>
                      )}
                    </div>
                  ))}
                </div>

                {/* Footer: stream info + global LUFS */}
                <div className="mt-1.5 flex items-center justify-between text-xs text-slate-500">
                  <span>{slot.stream.codec} · {slot.stream.sampleRate / 1000}kHz · {chCount}ch</span>
                  {lufsMax !== null && (
                    <span className="text-sky-400 font-mono text-[11px]">
                      {lufsMax.toFixed(1)} LU
                    </span>
                  )}
                </div>
              </div>
            );
          })()}
        </>
      ) : (
        // Empty slot
        <div className="flex flex-col items-center justify-center h-full min-h-[180px] p-4">
          <div className={`
            w-16 h-16 rounded-full border-2 border-dashed flex items-center justify-center mb-2
            ${isOver ? 'border-blue-500 text-blue-400' : 'border-slate-600 text-slate-600'}
          `}>
            <Radio size={24} />
          </div>
          <span className={`text-sm ${isOver ? 'text-blue-400' : 'text-slate-600'}`}>
            {t.dropHere}
          </span>
        </div>
      )}
    </div>
  );
};

const MonitoringWall: React.FC<MonitoringWallProps> = ({
  t,
  slots,
  streamLevels,
  streamPtpStatuses,
  onRemoveFromSlot,
}) => {
  return (
    <main className="flex-1 p-4 overflow-auto bg-slate-900">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-white">{t.monitoring}</h2>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {slots.map((slot) => (
          <MonitorSlotComponent
            key={slot.id}
            slot={slot}
            levels={slot.stream ? streamLevels[slot.stream.id] : undefined}
            ptpStatus={slot.stream ? streamPtpStatuses[slot.stream.id] : undefined}
            t={t}
            onRemove={() => onRemoveFromSlot(slot.id)}
          />
        ))}
      </div>
    </main>
  );
};

export default MonitoringWall;
