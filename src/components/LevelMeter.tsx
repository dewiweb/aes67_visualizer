import React from 'react';
import { DB_MIN, DB_MAX, DB_FLOOR } from '../types';

interface LevelMeterProps {
  current: number;
  peak: number;
  lufs?: number;
  className?: string;
  showLabels?: boolean;
  vertical?: boolean;
}

const LevelMeter: React.FC<LevelMeterProps> = ({
  current,
  peak,
  lufs,
  className = '',
  showLabels = false,
  vertical = false,
}) => {
  // Clamp values
  const clampedCurrent = Math.max(DB_MIN, Math.min(DB_MAX, current));
  const clampedPeak = Math.max(DB_MIN, Math.min(DB_MAX, peak));

  // Convert dB to percentage (0-100)
  const dbToPercent = (db: number) => {
    if (db <= DB_FLOOR) return 0;
    return ((db - DB_MIN) / (DB_MAX - DB_MIN)) * 100;
  };

  const currentPercent = dbToPercent(clampedCurrent);
  const peakPercent = dbToPercent(clampedPeak);

  // Color thresholds
  const getGradient = () => {
    if (vertical) {
      return 'linear-gradient(to top, #22c55e 0%, #22c55e 70%, #eab308 70%, #eab308 90%, #ef4444 90%, #ef4444 100%)';
    }
    return 'linear-gradient(to right, #22c55e 0%, #22c55e 70%, #eab308 70%, #eab308 90%, #ef4444 90%, #ef4444 100%)';
  };

  const lufsLabel = lufs !== undefined && lufs > DB_FLOOR
    ? `${lufs.toFixed(1)} LU`
    : null;

  if (vertical) {
    return (
      <div className={`flex flex-col items-center gap-1 ${className}`}>
        <div className="relative w-4 h-full bg-slate-800 rounded overflow-hidden border border-slate-700">
          {/* Level bar */}
          <div
            className="absolute bottom-0 left-0 right-0 transition-all duration-75"
            style={{
              height: `${currentPercent}%`,
              background: getGradient(),
            }}
          />
          {/* Peak indicator */}
          {peakPercent > 0 && (
            <div
              className="absolute left-0 right-0 h-0.5 bg-white transition-all duration-150"
              style={{ bottom: `${peakPercent}%` }}
            />
          )}
        </div>
        {showLabels && (
          <span className="text-[10px] text-slate-500 font-mono">
            {current > DB_FLOOR ? current.toFixed(0) : '-∞'}
          </span>
        )}
        {lufsLabel && (
          <span className="text-[9px] text-sky-400 font-mono whitespace-nowrap">{lufsLabel}</span>
        )}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      <div className="relative flex-1 h-full min-h-[8px] bg-slate-800 rounded overflow-hidden border border-slate-700">
        {/* Level bar */}
        <div
          className="absolute top-0 left-0 bottom-0 transition-all duration-75"
          style={{
            width: `${currentPercent}%`,
            background: getGradient(),
          }}
        />
        {/* Peak indicator */}
        {peakPercent > 0 && (
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-white transition-all duration-150"
            style={{ left: `${peakPercent}%` }}
          />
        )}
      </div>
      {showLabels && (
        <span className="text-[10px] text-slate-500 font-mono w-8 text-right">
          {current > DB_FLOOR ? current.toFixed(0) : '-∞'}
        </span>
      )}
      {lufsLabel && (
        <span className="text-[9px] text-sky-400 font-mono whitespace-nowrap">{lufsLabel}</span>
      )}
    </div>
  );
};

export default LevelMeter;
