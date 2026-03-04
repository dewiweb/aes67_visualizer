/**
 * Audio Meters Child Process
 * Handles multi-stream RTP level monitoring
 * Based on Digisynthetic/aes67-stream-monitor AudioMonitor.js
 */

const dgram = require('dgram');

const MAX_INT_24 = 8388607; // 2^23 - 1
const MAX_INT_16 = 32767;   // 2^15 - 1
const RTP_HEADER_SIZE = 12;
const DB_FLOOR = -100;

// Active monitors: streamId -> { socket, ip, port, channels, codec, accumulators, sampleCount }
const monitors = new Map();
let currentInterface = null;

/**
 * Start monitoring a stream
 */
function startMonitoring(stream) {
  const { id, mcast, port, channels, codec } = stream;
  
  if (monitors.has(id)) {
    console.log(`[Meters] Already monitoring ${id}`);
    return;
  }

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
    };

    socket.on('error', (err) => {
      console.error(`[Meters] Socket error for ${mcast}:${port}:`, err.message);
      
      // Detect port conflicts
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        process.send({
          type: 'port-conflict',
          port: port,
          message: `Port ${port} conflict: ${err.message}`,
          code: err.code,
          stream: { id, name: stream.name, mcast, port }
        });
      }
      
      stopMonitoring(id);
    });

    socket.on('message', (buffer) => {
      processRtpPacket(buffer, monitor);
    });

    socket.bind({ port, address: currentInterface, exclusive: false }, () => {
      try {
        socket.addMembership(mcast, currentInterface);
        console.log(`[Meters] Started monitoring ${stream.name || id} (${mcast}:${port})`);
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

    // Accumulate squares for RMS
    if (channelIdx < monitor.channels) {
      monitor.accumulators[channelIdx] += sample * sample;
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
        const rms = Math.sqrt(monitor.accumulators[i] / monitor.sampleCount);
        let db = 20 * Math.log10(rms / maxValue);

        if (!isFinite(db)) db = DB_FLOOR;
        if (db < DB_FLOOR) db = DB_FLOOR;
        if (db > 0) db = 0;

        // Update peak with decay
        if (db > monitor.peaks[i]) {
          monitor.peaks[i] = db;
        } else {
          monitor.peaks[i] = Math.max(DB_FLOOR, monitor.peaks[i] - 0.5);
        }

        levels.push({
          current: Math.round(db * 10) / 10,
          peak: Math.round(monitor.peaks[i] * 10) / 10,
        });

        // Reset accumulator
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
