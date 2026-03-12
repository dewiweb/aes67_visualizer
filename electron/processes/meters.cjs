/**
 * Audio Meters Child Process
 * Handles multi-stream RTP level monitoring
 * Based on Digisynthetic/aes67-stream-monitor AudioMonitor.js
 */

const dgram    = require('dgram');
const os       = require('os');
const IS_LINUX = os.platform() === 'linux';

const MAX_INT_24 = 8388607; // 2^23 - 1
const MAX_INT_16 = 32767;   // 2^15 - 1
const RTP_HEADER_SIZE = 12;
const DB_FLOOR = -100;

// ─── ITU-R BS.1770-4 K-weighting filter coefficients @ 48kHz ─────────────────
// Two biquad IIR stages in series.
// Stage 1: Pre-filter (high shelf)
const KW_B1 = [ 1.53512485958697, -2.69169618940638,  1.19839281085285];
const KW_A1 = [ 1.0,              -1.69065929318241,  0.73248077421585];
// Stage 2: RLB weighting filter (2nd-order highpass)
const KW_B2 = [ 1.0,              -2.0,               1.0             ];
const KW_A2 = [ 1.0,              -1.99004745483398,  0.99007225036603];

/**
 * Create per-channel K-weighting filter state (2 biquad stages, 2 delay samples each)
 */
function makeKwState() {
  return {
    x1_s1: 0, x2_s1: 0, y1_s1: 0, y2_s1: 0, // stage 1 delays
    x1_s2: 0, x2_s2: 0, y1_s2: 0, y2_s2: 0, // stage 2 delays
  };
}

/**
 * Apply both K-weighting biquad stages to one sample, return filtered sample.
 */
function applyKweighting(x, st) {
  // Stage 1
  const y1 = KW_B1[0] * x + KW_B1[1] * st.x1_s1 + KW_B1[2] * st.x2_s1
                           - KW_A1[1] * st.y1_s1 - KW_A1[2] * st.y2_s1;
  st.x2_s1 = st.x1_s1; st.x1_s1 = x;
  st.y2_s1 = st.y1_s1; st.y1_s1 = y1;
  // Stage 2
  const y2 = KW_B2[0] * y1 + KW_B2[1] * st.x1_s2 + KW_B2[2] * st.x2_s2
                            - KW_A2[1] * st.y1_s2 - KW_A2[2] * st.y2_s2;
  st.x2_s2 = st.x1_s2; st.x1_s2 = y1;
  st.y2_s2 = st.y1_s2; st.y1_s2 = y2;
  return y2;
}

// LUFS momentary window = 400ms at 48kHz = 19200 samples
const LUFS_WINDOW_SAMPLES = 19200;

// Active monitors: streamId -> { socket, ip, port, channels, codec, accumulators, sampleCount }
const monitors = new Map();
let currentInterface = null;

/**
 * Start monitoring a stream
 */
function startMonitoring(stream) {
  const { id, mcast, port, channels, codec } = stream;
  
  if (monitors.has(id)) return;

  if (!currentInterface) {
    console.warn('[Meters] No interface set');
    return;
  }

  try {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    
    const monitor = {
      id,
      ip: mcast,
      port,
      channels: channels || 2,
      codec: codec || 'L24',
      socket,
      accumulators: new Array(channels || 2).fill(0),
      peaks: new Array(channels || 2).fill(DB_FLOOR),
      sampleCount: 0,
      // K-weighting filter state per channel
      kwState: Array.from({ length: channels || 2 }, () => makeKwState()),
      // LUFS momentary: ring buffer of squared K-weighted samples per channel
      kwRing: Array.from({ length: channels || 2 }, () => new Float64Array(LUFS_WINDOW_SAMPLES)),
      kwRingPos: 0,
      kwRingFill: 0,   // how many samples accumulated (capped at LUFS_WINDOW_SAMPLES)
      kwAccum: new Float64Array(channels || 2), // running sum of ring
    };

    socket.on('error', (err) => {
      console.error(`[Meters] Socket error for ${mcast}:${port}:`, err.message);
      
      // Detect port conflicts
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        const isRtpMidiPort = port === 5004;
        const platform = os.platform();
        let message = `Port ${port} conflict: ${err.message}`;
        if (isRtpMidiPort && platform === 'darwin') {
          message = `Port 5004 conflict — likely Apple RTP MIDI (rtpmidi daemon).\n` +
            `Fix: System Settings → General → AirDrop & Handoff → disable "AirPlay Receiver"\n` +
            `or: sudo launchctl unload -w /Library/LaunchDaemons/com.apple.rtp.plist\n` +
            `or: sudo launchctl unload -w /System/Library/LaunchDaemons/com.apple.rtpmidid.plist`;
        } else if (isRtpMidiPort && platform === 'linux') {
          message = `Port 5004 conflict — another process is using the RTP default port.\n` +
            `Check: sudo lsof -i UDP:5004\n` +
            `Common culprits: jackd, pipewire-jack, qjackctl, raveloxmidi`;
        } else if (isRtpMidiPort && platform === 'win32') {
          message = `Port 5004 conflict — another process is using the RTP default port.\n` +
            `Check: netstat -ano | findstr :5004\n` +
            `Common culprits: Apple MIDI, loopMIDI, rtpMIDI driver`;
        }
        process.send({
          type: 'port-conflict',
          port: port,
          message,
          code: err.code,
          stream: { id, name: stream.name, mcast, port }
        });
      }
      
      stopMonitoring(id);
    });

    socket.on('message', (buffer) => {
      processRtpPacket(buffer, monitor);
    });

    // Linux: bind on the multicast group address so the kernel routes inbound
    // multicast packets to this socket. Binding on 0.0.0.0 works on Windows
    // but silently drops multicast on Linux.
    const bindAddress = IS_LINUX ? mcast : '0.0.0.0';
    socket.bind({ port, address: bindAddress, exclusive: false }, () => {
      try {
        socket.setMulticastInterface(currentInterface);
        socket.addMembership(mcast, currentInterface);
        console.log(`[Meters] Started monitoring ${stream.name || id} (${mcast}:${port}) bind=${bindAddress}`);
      } catch (e) {
        console.error(`[Meters] Multicast join error for ${mcast}:`, e.message);
      }
    });

    monitors.set(id, monitor);
  } catch (e) {
    console.error(`[Meters] Failed to create socket:`, e.message);
  }
}

/**
 * Stop monitoring a stream
 */
function stopMonitoring(streamId) {
  const monitor = monitors.get(streamId);
  
  if (monitor) {
    try {
      if (currentInterface) {
        monitor.socket.dropMembership(monitor.ip, currentInterface);
      }
      monitor.socket.close();
    } catch (e) { /* ignore */ }
    
    monitors.delete(streamId);
    console.log(`[Meters] Stopped monitoring ${streamId}`);
  }
}

/**
 * Process RTP packet and extract audio levels
 */
function processRtpPacket(buffer, monitor) {
  if (buffer.length <= RTP_HEADER_SIZE) return;

  const bytesPerSample = monitor.codec === 'L24' ? 3 : 2;
  const maxValue = monitor.codec === 'L24' ? MAX_INT_24 : MAX_INT_16;
  
  let offset = RTP_HEADER_SIZE;

  // Check for RTP extension header
  const firstByte = buffer.readUInt8(0);
  const csrcCount = firstByte & 0x0f;
  offset += csrcCount * 4;
  
  const extensionFlag = (firstByte >> 4) & 0x01;
  if (extensionFlag && buffer.length > offset + 4) {
    const extensionLength = buffer.readUInt16BE(offset + 2);
    offset += 4 + extensionLength * 4;
  }

  const end = buffer.length;
  let channelIdx = 0;

  while (offset + bytesPerSample <= end) {
    let sample;
    
    if (bytesPerSample === 3) {
      // L24: 24-bit big-endian
      const b0 = buffer[offset];
      const b1 = buffer[offset + 1];
      const b2 = buffer[offset + 2];
      sample = (b0 << 16) | (b1 << 8) | b2;
      
      // Sign extension for 24-bit
      if (sample & 0x800000) {
        sample = sample | 0xFF000000;
      }
    } else {
      // L16: 16-bit big-endian
      sample = buffer.readInt16BE(offset);
    }

    // Normalize sample to [-1.0, 1.0] for K-weighting
    const maxValue = monitor.codec === 'L24' ? MAX_INT_24 : MAX_INT_16;
    const normalised = sample / maxValue;

    if (channelIdx < monitor.channels) {
      // dBFS RMS accumulator (unnormalised squared)
      monitor.accumulators[channelIdx] += sample * sample;

      // K-weighted momentary LUFS ring buffer
      const kw = applyKweighting(normalised, monitor.kwState[channelIdx]);
      const kwSq = kw * kw;
      // Subtract oldest value from running sum, add new
      monitor.kwAccum[channelIdx] -= monitor.kwRing[channelIdx][monitor.kwRingPos];
      monitor.kwAccum[channelIdx] += kwSq;
      monitor.kwRing[channelIdx][monitor.kwRingPos] = kwSq;
    }

    // Advance ring position when last channel of a frame is processed
    if (channelIdx === monitor.channels - 1) {
      monitor.kwRingPos = (monitor.kwRingPos + 1) % LUFS_WINDOW_SAMPLES;
      if (monitor.kwRingFill < LUFS_WINDOW_SAMPLES) monitor.kwRingFill++;
    }

    offset += bytesPerSample;
    channelIdx++;

    if (channelIdx >= monitor.channels) {
      channelIdx = 0;
      monitor.sampleCount++;
    }
  }
}

/**
 * Calculate and emit levels for all monitors
 */
function calculateAndEmitLevels() {
  const results = {};

  for (const [id, monitor] of monitors) {
    const levels = [];

    if (monitor.sampleCount === 0) {
      // No samples received - silence
      for (let i = 0; i < monitor.channels; i++) {
        levels.push({ current: DB_FLOOR, peak: monitor.peaks[i] });
      }
    } else {
      const maxValue = monitor.codec === 'L24' ? MAX_INT_24 : MAX_INT_16;

      for (let i = 0; i < monitor.channels; i++) {
        // dBFS RMS
        const rms = Math.sqrt(monitor.accumulators[i] / monitor.sampleCount);
        let db = 20 * Math.log10(rms / maxValue);
        if (!isFinite(db)) db = DB_FLOOR;
        if (db < DB_FLOOR) db = DB_FLOOR;
        if (db > 0) db = 0;

        // Peak with decay
        if (db > monitor.peaks[i]) {
          monitor.peaks[i] = db;
        } else {
          monitor.peaks[i] = Math.max(DB_FLOOR, monitor.peaks[i] - 0.5);
        }

        // LUFS momentary (BS.1770 Eq. 2): -0.691 + 10*log10(mean_square_kw)
        let lufs = DB_FLOOR;
        if (monitor.kwRingFill > 0) {
          const n = monitor.kwRingFill;
          const meanSq = monitor.kwAccum[i] / n;
          if (meanSq > 0) {
            lufs = -0.691 + 10 * Math.log10(meanSq);
            if (lufs < DB_FLOOR) lufs = DB_FLOOR;
          }
        }

        levels.push({
          current: Math.round(db   * 10) / 10,
          peak:    Math.round(monitor.peaks[i] * 10) / 10,
          lufs:    Math.round(lufs * 10) / 10,
        });

        monitor.accumulators[i] = 0;
      }
      
      monitor.sampleCount = 0;
    }

    results[id] = levels;
  }

  if (Object.keys(results).length > 0) {
    process.send({ type: 'levels', levels: results });
  }
}

/**
 * Set network interface for all monitors
 */
function setInterface(address) {
  console.log(`[Meters] Interface set to ${address}`);
  
  // Restart all monitors with new interface
  const activeMonitors = Array.from(monitors.entries());
  
  for (const [id] of activeMonitors) {
    stopMonitoring(id);
  }
  
  currentInterface = address;
  
  // Note: Monitors will be restarted by the main process
}

// Calculate levels at 4Hz (250ms)
setInterval(calculateAndEmitLevels, 250);

// IPC message handler
process.on('message', (msg) => {
  switch (msg.type) {
    case 'start':
      startMonitoring(msg.stream);
      break;
    case 'stop':
      stopMonitoring(msg.streamId);
      break;
    case 'set-interface':
      setInterface(msg.address);
      break;
  }
});

process.on('disconnect', () => {
  for (const [id] of monitors) {
    stopMonitoring(id);
  }
  process.exit(0);
});
