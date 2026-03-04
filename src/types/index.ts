export interface Stream {
  id: string;
  name: string;
  mcast: string;
  port: number;
  channels: number;
  sampleRate: number;
  codec: 'L16' | 'L24';
  ptime: number;
  isSupported: boolean;
  unsupportedReason?: string;
  sourceType: 'sap' | 'manual' | 'dante' | 'ravenna';
  manual: boolean;
  dante?: boolean;
  danteDevice?: {
    host: string;
    model: string | null;
    manufacturer: string;
    isAES67: boolean;
    isRAVENNA?: boolean;
    software: string | null;
  };
  requiresSubscription?: boolean;
  description?: string;
  origin?: {
    address: string;
    sessionId: string;
    sessionVersion?: string;
  };
  raw?: string;
  rtpMap?: string;
  media?: any[];
  // Device info fields
  deviceIp?: string;
  sapSourceIp?: string;
  sessionId?: string;
  sessionVersion?: string;
  // PTP clock info
  ptpVersion?: string;
  ptpGrandmaster?: string;
  ptpDomain?: string;
  // Additional SDP info
  tool?: string;
  info?: string;
  mediaclk?: string;
  // Redundancy (ST2022-7)
  redundant?: boolean;
  redundantMids?: string;
  mid?: string;
}

export interface Device {
  ip: string;
  name: string;
  streams: Stream[];
  ptpGrandmaster?: string;
  ptpVersion?: string;
  ptpDomain?: string;
  tool?: string;
  streamCount: number;
  channelCount: number;
}

export interface PtpStatus {
  lockStatus: 'locked' | 'degraded' | 'unlocked' | 'unknown';
  driftPpm: number;
  ssrc: number;
  lastSrTime: string | null;
  sampleCount: number;
}

export interface StreamPtpStatuses {
  [streamId: string]: PtpStatus | null;
}

export interface ChannelLevel {
  current: number; // dBFS
  peak: number;    // dBFS peak hold
}

export interface StreamLevels {
  [streamId: string]: ChannelLevel[];
}

export interface MonitorSlot {
  id: string;
  streamId: string | null;
  stream: Stream | null;
}

export interface NetworkInterface {
  name: string;
  address: string;
  isCurrent?: boolean;
}

export interface AudioDevice {
  id: number;
  name: string;
  outputChannels: number;
  inputChannels: number;
  sampleRates: number[];
  isDefaultOutput: boolean;
}

export interface Settings {
  bufferSize: number;
  bufferEnabled: boolean;
  hideUnsupported: boolean;
  sdpDeleteTimeout: number;
  language: string;
}

export interface PersistentData {
  settings: Settings;
}

// Constants
export const TOTAL_SLOTS = 16;
export const DB_MIN = -60;
export const DB_MAX = 0;
export const DB_FLOOR = -100;

// Electron API types
export interface ElectronAPI {
  getInitialData: () => Promise<{
    interfaces: NetworkInterface[];
    persistentData: PersistentData;
    currentInterface: NetworkInterface | null;
  }>;
  getInterfaces: () => Promise<NetworkInterface[]>;
  setInterface: (address: string) => void;
  onInterfaceChanged: (callback: (iface: NetworkInterface) => void) => () => void;
  onStreamsUpdate: (callback: (streams: Stream[]) => void) => () => void;
  addManualStream: (sdp: string) => void;
  removeStream: (streamId: string) => void;
  startMonitoring: (stream: Stream) => void;
  stopMonitoring: (streamId: string) => void;
  onAudioLevels: (callback: (levels: StreamLevels) => void) => () => void;
  playStream: (data: PlayStreamData) => void;
  stopPlayback: () => void;
  onAudioStatus: (callback: (status: AudioStatus) => void) => () => void;
  onAudioError: (callback: (error: string) => void) => () => void;
  getAudioDevices: () => Promise<AudioDevice[]>;
  setAudioDevice: (device: AudioDevice) => void;
  saveSettings: (settings: Partial<Settings>) => void;
  onPortConflict: (callback: (data: PortConflictData) => void) => () => void;
  onSdpError: (callback: (error: string) => void) => () => void;
  onSdpStatus: (callback: (data: { status: string; port: number }) => void) => () => void;
  onPtpStatus: (callback: (data: { streamId: string; status: PtpStatus | null }) => void) => () => void;
}

export interface PortConflictData {
  port: number;
  message: string;
  blockingProcess: {
    pid: number;
    name: string;
  } | null;
  source?: 'sdp' | 'meters';
  stream?: {
    id: string;
    name: string;
    mcast: string;
    port: number;
  };
}

export interface PlayStreamData {
  streamId: string;
  streamName: string;
  mcast: string;
  port: number;
  codec: string;
  ptime: number;
  sampleRate: number;
  channels: number;
  ch1Map: number;
  ch2Map: number;
  bufferEnabled: boolean;
  bufferSize: number;
  filter?: boolean;
  filterAddr?: string;
}

export interface AudioStatus {
  playing: boolean;
  streamId?: string;
  streamName?: string;
}

declare global {
  interface Window {
    api: ElectronAPI;
  }
}
