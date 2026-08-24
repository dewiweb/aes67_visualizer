import React, { useState, useEffect, useCallback } from 'react';
import {
  DndContext,
  DragOverlay,
  useSensor,
  useSensors,
  PointerSensor,
  DragStartEvent,
  DragEndEvent,
} from '@dnd-kit/core';
import { translations, Language, languageNames } from './i18n/translations';
import {
  Stream,
  StreamLevels,
  StreamPtpStatuses,
  NetworkDevice,
  PtpClock,
  MonitorSlot,
  NetworkInterface,
  Settings,
  AudioDevice,
  AutoPlayConfig,
  TOTAL_SLOTS,
  AudioStatus,
  PortConflictData,
} from './types';
import Header from './components/Header';
import NavRail from './components/NavRail';
import MainPanel from './components/MainPanel';
import StreamCard from './components/StreamCard';
import SettingsPanel from './components/SettingsPanel';

export type ViewId = 'monitoring' | 'devices' | 'ptp' | 'routing' | 'permissions';

const App: React.FC = () => {
  // Language
  const [language, setLanguage] = useState<Language>('en');
  const t = translations[language];

  // Streams state
  const [streams, setStreams] = useState<Stream[]>([]);
  const [streamLevels, setStreamLevels] = useState<StreamLevels>({});
  const [streamPtpStatuses, setStreamPtpStatuses] = useState<StreamPtpStatuses>({});
  const [devices, setDevices] = useState<NetworkDevice[]>([]);
  const [ptpClocks, setPtpClocks] = useState<PtpClock[]>([]);

  // Monitor slots
  const [slots, setSlots] = useState<MonitorSlot[]>(
    Array.from({ length: TOTAL_SLOTS }, (_, i) => ({
      id: `slot-${i + 1}`,
      streamId: null,
      stream: null,
    }))
  );

  // Network & Settings
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([]);
  const [currentInterface, setCurrentInterface] = useState<NetworkInterface | null>(null);
  const [settings, setSettings] = useState<Settings>({
    bufferSize: 4,
    bufferEnabled: false,
    hideUnsupported: true,
    sdpDeleteTimeout: 300,
    language: 'en',
  });

  // Audio playback
  const [playingStreamId, setPlayingStreamId] = useState<string | null>(null);
  const playingStreamIdRef = React.useRef<string | null>(null);

  // Audio devices
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [currentAudioDevice, setCurrentAudioDevice] = useState<AudioDevice | null>(null);

  // UI state
  const [showSettings, setShowSettings] = useState(false);
  const [activeDragStream, setActiveDragStream] = useState<Stream | null>(null);
  const [portConflict, setPortConflict] = useState<PortConflictData | null>(null);
  const [portConflicts, setPortConflicts] = useState<PortConflictData[]>([]);
  const [mdnsError, setMdnsError] = useState<{ code: string; message: string } | null>(null);
  const [activeView, setActiveView] = useState<ViewId>('monitoring');

  // Auto-play state
  const [autoPlayConfig, setAutoPlayConfig] = useState<AutoPlayConfig | null>(null);
  const autoPlayConfigRef = React.useRef<AutoPlayConfig | null>(null);
  const autoPlayStreamIdRef = React.useRef<string | null>(null);
  const manualStopRef = React.useRef<boolean>(false);
  const streamsRef = React.useRef<Stream[]>([]);
  const settingsRef = React.useRef(settings);

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  // Initialize app
  useEffect(() => {
    if (!window.api) {
      console.warn('Electron API not available');
      return;
    }

    // Get initial data
    window.api.getInitialData().then((data) => {
      setInterfaces(data.interfaces);
      if (data.currentInterface) {
        setCurrentInterface(data.currentInterface);
      }
      if (data.persistentData?.settings) {
        setSettings(data.persistentData.settings);
        setLanguage(data.persistentData.settings.language as Language || 'en');
      }
    });

    // Load auto-play config
    window.api.getAutoPlay().then((config) => {
      if (config && config.enabled && config.sdp) {
        setAutoPlayConfig(config);
        autoPlayConfigRef.current = config;
        // Add the manual stream immediately — playback starts when the stream appears
        window.api.addManualStream(config.sdp);
        console.log('[AutoPlay] Config loaded, manual stream added');
      }
    });

    // Subscribe to streams updates
    const unsubStreams = window.api.onStreamsUpdate((newStreams) => {
      setStreams(newStreams);

      // Auto-play: start playback the first time the manual stream appears
      const cfg = autoPlayConfigRef.current;
      if (cfg && cfg.enabled && !autoPlayStreamIdRef.current && !manualStopRef.current) {
        const manualStream = newStreams.find(
          (s) => s.sourceType === 'manual' && s.isSupported
        );
        if (manualStream) {
          autoPlayStreamIdRef.current = manualStream.id;
          console.log(`[AutoPlay] Starting playback: ${manualStream.name} (${manualStream.mcast}:${manualStream.port})`);
          window.api.playStream({
            streamId: manualStream.id,
            streamName: manualStream.name,
            mcast: manualStream.mcast,
            port: manualStream.port,
            codec: manualStream.codec,
            ptime: manualStream.ptime,
            sampleRate: manualStream.sampleRate,
            channels: manualStream.channels,
            ch1Map: cfg.ch1,
            ch2Map: cfg.ch2,
            bufferEnabled: settingsRef.current.bufferEnabled,
            bufferSize: settingsRef.current.bufferSize,
          });
        }
      }
    });

    // Subscribe to audio levels
    const unsubLevels = window.api.onAudioLevels((levels) => {
      setStreamLevels(levels);
    });

    // Subscribe to audio status
    const unsubAudioStatus = window.api.onAudioStatus((status: AudioStatus) => {
      const id = status.playing ? status.streamId || null : null;
      playingStreamIdRef.current = id;
      setPlayingStreamId(id);

      // Auto-play: reconnect if playback stopped unexpectedly (not a manual stop)
      // Only reconnect if we were actually playing before (playingStreamIdRef was set)
      const cfg = autoPlayConfigRef.current;
      if (!status.playing && cfg && cfg.enabled && autoPlayStreamIdRef.current && !manualStopRef.current && playingStreamIdRef.current) {
        console.log('[AutoPlay] Playback stopped unexpectedly, reconnecting in 2s...');
        playingStreamIdRef.current = null;
        setTimeout(() => {
          if (manualStopRef.current) return; // user stopped during the delay
          const s = streamsRef.current.find(
            (s) => s.id === autoPlayStreamIdRef.current && s.isSupported
          );
          if (s) {
            console.log(`[AutoPlay] Reconnecting: ${s.name}`);
            window.api.playStream({
              streamId: s.id,
              streamName: s.name,
              mcast: s.mcast,
              port: s.port,
              codec: s.codec,
              ptime: s.ptime,
              sampleRate: s.sampleRate,
              channels: s.channels,
              ch1Map: cfg.ch1,
              ch2Map: cfg.ch2,
              bufferEnabled: settingsRef.current.bufferEnabled,
              bufferSize: settingsRef.current.bufferSize,
            });
          }
        }, 2000);
      }
    });

    // Subscribe to interface changes
    const unsubInterface = window.api.onInterfaceChanged((iface) => {
      setCurrentInterface(iface);
    });

    // Subscribe to port conflicts
    const unsubPortConflict = window.api.onPortConflict((data) => {
      setPortConflict(data);
      setPortConflicts(prev => {
        const filtered = prev.filter(c => c.port !== data.port || c.source !== data.source);
        return [...filtered, data];
      });
    });

    // Subscribe to SDP status (clears conflict on success)
    const unsubSdpStatus = window.api.onSdpStatus(() => {
      setPortConflict(null);
    });

    // Subscribe to mDNS system errors (avahi missing / daemon not running)
    const unsubMdnsError = window.api.onMdnsError && window.api.onMdnsError((data) => {
      setMdnsError(data);
    });

    // Subscribe to network device list
    const unsubDanteDevices = window.api.onNetworkDevices((d) => {
      setDevices(d);
    });

    // Subscribe to PTP status updates (legacy RTCP-based, kept for StreamCard badges)
    const unsubPtpStatus = window.api.onPtpStatus && window.api.onPtpStatus(({ streamId, status }) => {
      setStreamPtpStatuses((prev) => {
        if (status === null) {
          const next = { ...prev };
          delete next[streamId];
          return next;
        }
        return { ...prev, [streamId]: status };
      });
    });

    // Subscribe to PTP clocks (IEEE 1588 network-wide monitoring)
    const unsubPtpClocks = window.api.onPtpClocks((clocks) => {
      setPtpClocks(clocks);
    });

    return () => {
      unsubStreams();
      unsubLevels();
      unsubAudioStatus();
      unsubInterface();
      unsubPortConflict();
      unsubSdpStatus();
      if (unsubPtpStatus) unsubPtpStatus();
      unsubPtpClocks();
      unsubDanteDevices();
      if (unsubMdnsError) unsubMdnsError();
    };
  }, []);

  // Keep slot stream objects in sync when SAP refresh updates stream metadata.
  // This must NOT trigger monitoring restarts — it only updates stale references.
  useEffect(() => {
    if (streams.length === 0) return;
    setSlots((prev) => {
      let changed = false;
      const next = prev.map((slot) => {
        if (!slot.stream) return slot;
        const fresh = streams.find((s) => s.id === slot.stream!.id);
        if (fresh && fresh !== slot.stream) {
          changed = true;
          return { ...slot, stream: fresh };
        }
        return slot;
      });
      return changed ? next : prev;
    });
  }, [streams]);

  // Keep refs in sync for use in IPC callbacks
  useEffect(() => {
    streamsRef.current = streams;
    settingsRef.current = settings;
  });

  // Start monitoring when slots change (stream added/removed from wall).
  // Does NOT depend on 'streams' — uses slot.stream directly to avoid
  // triggering on every SAP refresh.
  useEffect(() => {
    if (!window.api) return;
    slots.forEach((slot) => {
      if (slot.stream) {
        window.api.startMonitoring(slot.stream);
      }
    });
    // Note: we don't stop monitoring here — meters process guards against duplicates
  }, [slots]);

  // Handle interface change
  const handleInterfaceChange = useCallback((address: string) => {
    if (window.api) {
      window.api.setInterface(address);
    }
  }, []);

  // Handle settings change
  const handleSettingsChange = useCallback((newSettings: Partial<Settings>) => {
    setSettings((prev) => {
      const updated = { ...prev, ...newSettings };
      if (window.api) {
        window.api.saveSettings(updated);
      }
      if (newSettings.language) {
        setLanguage(newSettings.language as Language);
      }
      return updated;
    });
  }, []);

  // Handle audio device change
  const handleAudioDeviceChange = useCallback((device: AudioDevice) => {
    setCurrentAudioDevice(device);
    if (window.api) {
      window.api.setAudioDevice(device);
    }
  }, []);

  // Handle auto-play config change
  const handleAutoPlayChange = useCallback((config: AutoPlayConfig | null) => {
    setAutoPlayConfig(config);
    autoPlayConfigRef.current = config;
    if (window.api) {
      window.api.setAutoPlay(config);
    }
    if (config && config.enabled) {
      // If enabling, add the manual stream now
      if (window.api && config.sdp) {
        window.api.addManualStream(config.sdp);
      }
    } else {
      // If disabling, stop playback
      if (window.api) {
        window.api.stopPlayback();
      }
      autoPlayStreamIdRef.current = null;
    }
  }, []);

  // Fetch audio devices when settings panel opens
  const handleOpenSettings = useCallback(async () => {
    if (window.api) {
      const devices = await window.api.getAudioDevices();
      setAudioDevices(devices);
    }
    setShowSettings(true);
  }, []);

  // Handle manual SDP add
  const handleAddManualStream = useCallback((sdp: string) => {
    if (window.api) {
      window.api.addManualStream(sdp);
    }
  }, []);

  // Handle manual SDP edit (remove old + add new)
  const handleEditManualStream = useCallback((streamId: string, sdp: string) => {
    if (window.api) {
      window.api.removeStream(streamId);
      window.api.addManualStream(sdp);
    }
    // Also remove from slots if it was in the monitoring wall
    setSlots((prev) =>
      prev.map((slot) =>
        slot.streamId === streamId
          ? { ...slot, streamId: null, stream: null }
          : slot
      )
    );
  }, []);

  // Export streams as JSON
  const handleExportJson = useCallback(() => {
    const data = {
      exportedAt: new Date().toISOString(),
      streams: streams.map((s) => ({
        id: s.id,
        name: s.name,
        mcast: s.mcast,
        port: s.port,
        codec: s.codec,
        sampleRate: s.sampleRate,
        channels: s.channels,
        ptime: s.ptime,
        sourceType: s.sourceType,
        ptpGrandmaster: s.ptpGrandmaster,
        ptpVersion: s.ptpVersion,
        ptpDomain: s.ptpDomain,
        ptpStatus: streamPtpStatuses[s.id] || null,
        tool: s.tool,
        dante: s.dante,
        danteDevice: s.danteDevice,
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aes67-streams-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [streams, streamPtpStatuses]);

  // Handle stream removal
  const handleRemoveStream = useCallback((streamId: string) => {
    if (window.api) {
      window.api.removeStream(streamId);
    }
    // Also remove from slots
    setSlots((prev) =>
      prev.map((slot) =>
        slot.streamId === streamId
          ? { ...slot, streamId: null, stream: null }
          : slot
      )
    );
  }, []);

  // Handle play/stop
  const handlePlayStream = useCallback(
    (stream: Stream, ch1: number, ch2: number) => {
      if (!window.api) return;

      if (playingStreamId === stream.id) {
        window.api.stopPlayback();
        manualStopRef.current = true;
        playingStreamIdRef.current = null;
        setPlayingStreamId(null);
      } else {
        manualStopRef.current = false;
        window.api.playStream({
          streamId: stream.id,
          streamName: stream.name,
          mcast: stream.mcast,
          port: stream.port,
          codec: stream.codec,
          ptime: stream.ptime,
          sampleRate: stream.sampleRate,
          channels: stream.channels,
          ch1Map: ch1,
          ch2Map: ch2,
          bufferEnabled: settings.bufferEnabled,
          bufferSize: settings.bufferSize,
        });
      }
    },
    [playingStreamId, settings]
  );

  // DnD handlers
  const handleDragStart = (event: DragStartEvent) => {
    const stream = streams.find((s) => s.id === event.active.id);
    if (stream) {
      setActiveDragStream(stream);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragStream(null);

    if (!over) return;

    const streamId = active.id as string;
    const slotId = over.id as string;

    // Check if dropping on a slot
    if (slotId.startsWith('slot-')) {
      const stream = streams.find((s) => s.id === streamId);
      if (stream && stream.isSupported) {
        setSlots((prev) =>
          prev.map((slot) =>
            slot.id === slotId
              ? { ...slot, streamId: stream.id, stream }
              : slot
          )
        );
      }
    }
  };

  // Remove stream from slot
  const handleRemoveFromSlot = useCallback((slotId: string) => {
    setSlots((prev) =>
      prev.map((slot) =>
        slot.id === slotId ? { ...slot, streamId: null, stream: null } : slot
      )
    );
  }, []);

  // Filter streams
  const filteredStreams = settings.hideUnsupported
    ? streams.filter((s) => s.isSupported)
    : streams;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="h-screen w-screen flex flex-col bg-slate-900 text-white overflow-hidden">
        <Header
          t={t}
          language={language}
          languageNames={languageNames}
          interfaces={interfaces}
          currentInterface={currentInterface}
          onInterfaceChange={handleInterfaceChange}
          onLanguageChange={(lang) => handleSettingsChange({ language: lang })}
          onSettingsClick={handleOpenSettings}
        />

        {/* Port conflict warning banner */}
        {portConflict && (
          <div className="bg-red-900/90 border-b border-red-700 px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-red-200 text-2xl">⚠️</span>
              <div>
                <p className="text-red-100 font-medium">
                  {t.portConflict || 'Port conflict detected'}
                  {portConflict.source === 'meters' && portConflict.stream && (
                    <span className="font-normal text-red-200 ml-2">
                      ({t.metersFor || 'Meters for'}: {portConflict.stream.name})
                    </span>
                  )}
                </p>
                <p className="text-red-200 text-sm">
                  Port {portConflict.port} {t.portInUse || 'is already in use'}.
                  {portConflict.blockingProcess && (
                    <span className="font-mono ml-1">
                      {t.blockingProcess || 'Blocking process'}: {portConflict.blockingProcess.name} (PID: {portConflict.blockingProcess.pid})
                    </span>
                  )}
                </p>
                <p className="text-red-300 text-xs mt-1">
                  {t.portConflictHint || 'Please close the conflicting application or stop the service using this port.'}
                </p>
              </div>
            </div>
            <button
              onClick={() => setPortConflict(null)}
              className="text-red-300 hover:text-white p-1"
            >
              ✕
            </button>
          </div>
        )}

        <div className="flex-1 flex overflow-hidden">
          <NavRail
            activeView={activeView}
            onViewChange={setActiveView}
            streamCount={filteredStreams.length}
            deviceCount={new Set([
              ...devices.map(d => d.ip).filter(Boolean),
              ...streams.map(s => s.deviceIp || s.sapSourceIp).filter(Boolean) as string[],
            ]).size}
            ptpCount={ptpClocks.length}
            conflictCount={portConflicts.length}
          />
          <MainPanel
            activeView={activeView}
            t={t}
            streams={filteredStreams}
            streamLevels={streamLevels}
            streamPtpStatuses={streamPtpStatuses}
            devices={devices}
            ptpClocks={ptpClocks}
            slots={slots}
            playingStreamId={playingStreamId}
            portConflicts={portConflicts}
            mdnsError={mdnsError}
            onAddManualStream={handleAddManualStream}
            onEditManualStream={handleEditManualStream}
            onRemoveStream={handleRemoveStream}
            onPlayStream={handlePlayStream}
            onExportJson={handleExportJson}
            onRemoveFromSlot={handleRemoveFromSlot}
          />
        </div>

        {/* Drag overlay */}
        <DragOverlay>
          {activeDragStream && (
            <div className="drag-overlay">
              <StreamCard
                stream={activeDragStream}
                levels={streamLevels[activeDragStream.id]}
                isPlaying={false}
                isDragging
              />
            </div>
          )}
        </DragOverlay>

        {/* Settings modal */}
        {showSettings && (
          <SettingsPanel
            t={t}
            settings={settings}
            language={language}
            languageNames={languageNames}
            audioDevices={audioDevices}
            currentAudioDevice={currentAudioDevice}
            autoPlayConfig={autoPlayConfig}
            onSettingsChange={handleSettingsChange}
            onAudioDeviceChange={handleAudioDeviceChange}
            onAutoPlayChange={handleAutoPlayChange}
            onClose={() => setShowSettings(false)}
          />
        )}
      </div>
    </DndContext>
  );
};

export default App;
