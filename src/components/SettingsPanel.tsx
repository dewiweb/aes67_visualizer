import React, { useState } from 'react';
import { X } from 'lucide-react';
import { Settings, AudioDevice, AutoPlayConfig } from '../types';
import { Language } from '../i18n/translations';

interface SettingsPanelProps {
  t: Record<string, string>;
  settings: Settings;
  language: Language;
  languageNames: Record<Language, string>;
  audioDevices: AudioDevice[];
  currentAudioDevice: AudioDevice | null;
  autoPlayConfig: AutoPlayConfig | null;
  onSettingsChange: (settings: Partial<Settings>) => void;
  onAudioDeviceChange: (device: AudioDevice) => void;
  onAutoPlayChange: (config: AutoPlayConfig | null) => void;
  onClose: () => void;
}

const SettingsPanel: React.FC<SettingsPanelProps> = ({
  t,
  settings,
  language,
  languageNames,
  audioDevices,
  currentAudioDevice,
  autoPlayConfig,
  onSettingsChange,
  onAudioDeviceChange,
  onAutoPlayChange,
  onClose,
}) => {
  const [autoPlayEnabled, setAutoPlayEnabled] = useState(autoPlayConfig?.enabled ?? false);
  const [autoPlaySdp, setAutoPlaySdp] = useState(autoPlayConfig?.sdp ?? '');
  const [autoPlayCh1, setAutoPlayCh1] = useState(autoPlayConfig?.ch1 ?? 0);
  const [autoPlayCh2, setAutoPlayCh2] = useState(autoPlayConfig?.ch2 ?? 1);

  const saveAutoPlay = (enabled: boolean, sdp: string, ch1: number, ch2: number) => {
    if (!enabled || !sdp.trim()) {
      onAutoPlayChange(null);
      return;
    }
    onAutoPlayChange({
      enabled: true,
      sdp: sdp.trim(),
      audioDeviceName: currentAudioDevice?.name || '',
      ch1,
      ch2,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-slate-800 rounded-xl border border-slate-700 w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h2 className="text-lg font-semibold">{t.settings}</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-700 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4 overflow-y-auto">
          {/* Language */}
          <div className="space-y-2">
            <label className="text-sm text-slate-400">{t.language}</label>
            <select
              value={language}
              onChange={(e) => onSettingsChange({ language: e.target.value })}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            >
              {Object.entries(languageNames).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          {/* Audio Device */}
          <div className="space-y-2">
            <label className="text-sm text-slate-400">{t.audioDevice}</label>
            <select
              value={currentAudioDevice?.name || ''}
              onChange={(e) => {
                const device = audioDevices.find(d => d.name === e.target.value);
                if (device) onAudioDeviceChange(device);
              }}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            >
              {audioDevices.length === 0 && (
                <option value="">No audio devices</option>
              )}
              {audioDevices.map((device, index) => (
                <option key={`${device.name}-${index}`} value={device.name}>
                  {device.name}
                </option>
              ))}
            </select>
          </div>

          {/* Jitter Buffer */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm text-slate-400">{t.bufferEnabled}</label>
              <button
                onClick={() => onSettingsChange({ bufferEnabled: !settings.bufferEnabled })}
                className={`
                  relative w-11 h-6 rounded-full transition-colors
                  ${settings.bufferEnabled ? 'bg-blue-600' : 'bg-slate-600'}
                `}
              >
                <span
                  className={`
                    absolute top-1 w-4 h-4 bg-white rounded-full transition-transform
                    ${settings.bufferEnabled ? 'left-6' : 'left-1'}
                  `}
                />
              </button>
            </div>

            {settings.bufferEnabled && (
              <div className="flex items-center gap-3">
                <label className="text-sm text-slate-400">{t.bufferSize}</label>
                <input
                  type="range"
                  min="4"
                  max="64"
                  step="4"
                  value={settings.bufferSize}
                  onChange={(e) => onSettingsChange({ bufferSize: parseInt(e.target.value) })}
                  className="flex-1"
                />
                <span className="text-sm text-slate-300 w-8 text-right">
                  {settings.bufferSize}
                </span>
              </div>
            )}
          </div>

          {/* Hide Unsupported */}
          <div className="flex items-center justify-between">
            <label className="text-sm text-slate-400">{t.hideUnsupported}</label>
            <button
              onClick={() => onSettingsChange({ hideUnsupported: !settings.hideUnsupported })}
              className={`
                relative w-11 h-6 rounded-full transition-colors
                ${settings.hideUnsupported ? 'bg-blue-600' : 'bg-slate-600'}
              `}
            >
              <span
                className={`
                  absolute top-1 w-4 h-4 bg-white rounded-full transition-transform
                  ${settings.hideUnsupported ? 'left-6' : 'left-1'}
                `}
              />
            </button>
          </div>

          {/* Stream Timeout */}
          <div className="space-y-2">
            <label className="text-sm text-slate-400">{t.streamTimeout}</label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="60"
                max="600"
                step="30"
                value={settings.sdpDeleteTimeout}
                onChange={(e) => onSettingsChange({ sdpDeleteTimeout: parseInt(e.target.value) })}
                className="flex-1"
              />
              <span className="text-sm text-slate-300 w-12 text-right">
                {settings.sdpDeleteTimeout}s
              </span>
            </div>
          </div>

          {/* Auto-play section */}
          <div className="border-t border-slate-700 pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-slate-200">
                  {t.autoPlay || 'Auto-Play'}
                </label>
                <p className="text-xs text-slate-500 mt-0.5">
                  {t.autoPlayDesc || 'Automatically play a stream on startup and reconnect if playback stops'}
                </p>
              </div>
              <button
                onClick={() => {
                  const newEnabled = !autoPlayEnabled;
                  setAutoPlayEnabled(newEnabled);
                  if (!newEnabled) saveAutoPlay(false, '', 0, 0);
                }}
                className={`
                  relative w-11 h-6 rounded-full transition-colors shrink-0
                  ${autoPlayEnabled ? 'bg-blue-600' : 'bg-slate-600'}
                `}
              >
                <span
                  className={`
                    absolute top-1 w-4 h-4 bg-white rounded-full transition-transform
                    ${autoPlayEnabled ? 'left-6' : 'left-1'}
                  `}
                />
              </button>
            </div>

            {autoPlayEnabled && (
              <>
                <div className="space-y-1">
                  <label className="text-xs text-slate-400">SDP</label>
                  <textarea
                    value={autoPlaySdp}
                    onChange={(e) => setAutoPlaySdp(e.target.value)}
                    placeholder={`v=0\r\no=- 1234567890 1234567890 IN IP4 192.168.20.10\r\ns=Lawo Stream\r\nc=IN IP4 230.20.10.20\r\nm=audio 5004 RTP/AVP 96\r\n...`}
                    className="w-full min-h-[100px] bg-slate-900 border border-slate-600 rounded-lg p-2 text-xs font-mono text-slate-300 resize-none focus:outline-none focus:border-blue-500"
                    spellCheck={false}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs text-slate-400">
                      {t.channel || 'Channel'} 1 (L)
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="63"
                      value={autoPlayCh1}
                      onChange={(e) => setAutoPlayCh1(parseInt(e.target.value) || 0)}
                      className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-slate-400">
                      {t.channel || 'Channel'} 2 (R)
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="63"
                      value={autoPlayCh2}
                      onChange={(e) => setAutoPlayCh2(parseInt(e.target.value) || 1)}
                      className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>

                <button
                  onClick={() => saveAutoPlay(true, autoPlaySdp, autoPlayCh1, autoPlayCh2)}
                  disabled={!autoPlaySdp.trim()}
                  className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
                >
                  {t.saveAutoPlay || 'Save & Start Auto-Play'}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-slate-700">
          <button
            onClick={onClose}
            className="w-full py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition-colors"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsPanel;
