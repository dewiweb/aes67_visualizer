/**
 * PTP Monitor Child Process
 * Listens to RTCP SR (Sender Reports) on active streams to infer PTP lock status.
 * AES67 streams carry RTP timestamps derived from PTP; consecutive RTCP SR packets
 * allow us to measure clock drift and determine if the source is PTP-locked.
 *
 * RTCP SR packet format (RFC 3550):
 *   - 4 bytes: V(2) P(1) RC(5) PT=200(8) Length(16)
 *   - 4 bytes: SSRC
 *   - 8 bytes: NTP timestamp (64-bit: 32 MSB seconds, 32 LSB fraction)
 *   - 4 bytes: RTP timestamp
 *   - 4 bytes: Sender packet count
 *   - 4 bytes: Sender octet count
 */

const dgram = require('dgram');

const RTCP_PT_SR = 200;
const RTCP_VERSION = 2;

// Active stream monitors: streamId -> { socket, mcast, port, ssrc, history, lastNtp, lastRtp }
const monitors = new Map();
let currentInterface = null;

// PTP lock detection thresholds
const DRIFT_LOCKED_PPM = 2;      // < 2 ppm = locked
const DRIFT_WARN_PPM = 50;       // < 50 ppm = degraded
const MIN_SAMPLES_FOR_LOCK = 3;  // Need at least 3 SR reports

/**
 * Convert 64-bit NTP timestamp (two 32-bit halves) to seconds (float)
 */
function ntpToSeconds(seconds, fraction) {
  return seconds + fraction / 0xFFFFFFFF;
}

/**
 * Compute drift in PPM between two RTCP SR observations
 */
function computeDriftPpm(prev, curr, sampleRate) {
  const ntpDelta = ntpToSeconds(curr.ntpSec, curr.ntpFrac) -
                   ntpToSeconds(prev.ntpSec, prev.ntpFrac);
  if (ntpDelta <= 0) return null;

  // RTP timestamp delta (handle 32-bit wraparound)
  let rtpDelta = (curr.rtpTs - prev.rtpTs) >>> 0;
  if (rtpDelta > 0x80000000) rtpDelta -= 0x100000000;

  const expectedRtpDelta = ntpDelta * sampleRate;
  if (expectedRtpDelta === 0) return null;

  const driftPpm = Math.abs((rtpDelta - expectedRtpDelta) / expectedRtpDelta) * 1e6;
  return driftPpm;
}

/**
 * Determine lock status from drift history
 */
function determineLockStatus(driftSamples) {
  if (driftSamples.length < MIN_SAMPLES_FOR_LOCK) return 'unknown';
  const avg = driftSamples.reduce((a, b) => a + b, 0) / driftSamples.length;
  if (avg < DRIFT_LOCKED_PPM) return 'locked';
  if (avg < DRIFT_WARN_PPM) return 'degraded';
  return 'unlocked';
}

/**
 * Process RTCP packet
 */
function processRtcpPacket(buffer, monitor) {
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const firstByte = buffer.readUInt8(offset);
    const version = (firstByte >> 6) & 0x03;
    if (version !== RTCP_VERSION) break;

    const packetType = buffer.readUInt8(offset + 1);
    const length = (buffer.readUInt16BE(offset + 2) + 1) * 4;

    if (offset + length > buffer.length) break;

    if (packetType === RTCP_PT_SR && length >= 28) {
      const ssrc = buffer.readUInt32BE(offset + 4);
      const ntpSec = buffer.readUInt32BE(offset + 8);
      const ntpFrac = buffer.readUInt32BE(offset + 12);
      const rtpTs = buffer.readUInt32BE(offset + 16);

      handleSenderReport(monitor, { ssrc, ntpSec, ntpFrac, rtpTs });
    }

    offset += length;
  }
}

/**
 * Handle a parsed RTCP SR
 */
function handleSenderReport(monitor, report) {
  // First report — just record, no drift yet
  if (!monitor.lastReport) {
    monitor.lastReport = report;
    monitor.driftSamples = [];
    return;
  }

  // Only track same SSRC
  if (report.ssrc !== monitor.lastReport.ssrc) {
    monitor.lastReport = report;
    monitor.driftSamples = [];
    return;
  }

  const drift = computeDriftPpm(monitor.lastReport, report, monitor.sampleRate);
  monitor.lastReport = report;

  if (drift === null) return;

  // Keep rolling window of 10 samples
  monitor.driftSamples.push(drift);
  if (monitor.driftSamples.length > 10) {
    monitor.driftSamples.shift();
  }

  const lockStatus = determineLockStatus(monitor.driftSamples);
  const avgDrift = monitor.driftSamples.reduce((a, b) => a + b, 0) / monitor.driftSamples.length;

  // NTP seconds to ISO for last SR time
  const NTP_EPOCH_OFFSET = 2208988800; // seconds between 1900 and 1970
  const unixSec = report.ntpSec - NTP_EPOCH_OFFSET;
  const lastSrTime = unixSec > 0 ? new Date(unixSec * 1000).toISOString() : null;

  process.send({
    type: 'ptp-status',
    streamId: monitor.id,
    status: {
      lockStatus,
      driftPpm: Math.round(avgDrift * 100) / 100,
      ssrc: report.ssrc >>> 0,
      lastSrTime,
      sampleCount: monitor.driftSamples.length,
    },
  });
}

/**
 * Start monitoring RTCP for a stream
 * RTCP port is conventionally RTP port + 1
 */
function startMonitoring(stream) {
  const { id, mcast, port, sampleRate } = stream;

  if (monitors.has(id)) return;
  if (!currentInterface) {
    console.warn('[PTP] No interface set');
    return;
  }

  const rtcpPort = port + 1;

  try {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const monitor = {
      id,
      mcast,
      port: rtcpPort,
      sampleRate: sampleRate || 48000,
      socket,
      lastReport: null,
      driftSamples: [],
    };

    socket.on('error', (err) => {
      console.error(`[PTP] Socket error ${mcast}:${rtcpPort}:`, err.message);
      stopMonitoring(id);
    });

    socket.on('message', (buf) => processRtcpPacket(buf, monitor));

    socket.bind({ port: rtcpPort, address: currentInterface, exclusive: false }, () => {
      try {
        socket.addMembership(mcast, currentInterface);
        console.log(`[PTP] Monitoring RTCP for ${stream.name || id} (${mcast}:${rtcpPort})`);
      } catch (e) {
        console.error(`[PTP] Multicast join error ${mcast}:`, e.message);
      }
    });

    monitors.set(id, monitor);
  } catch (e) {
    console.error('[PTP] Failed to create socket:', e.message);
  }
}

/**
 * Stop monitoring RTCP for a stream
 */
function stopMonitoring(streamId) {
  const monitor = monitors.get(streamId);
  if (monitor) {
    try {
      if (currentInterface) monitor.socket.dropMembership(monitor.mcast, currentInterface);
      monitor.socket.close();
    } catch (e) { /* ignore */ }
    monitors.delete(streamId);

    // Notify renderer that status is gone
    process.send({
      type: 'ptp-status',
      streamId,
      status: null,
    });

    console.log(`[PTP] Stopped monitoring ${streamId}`);
  }
}

/**
 * Set network interface — restart all monitors
 */
function setInterface(address) {
  const active = Array.from(monitors.entries()).map(([id, m]) => ({
    id,
    mcast: m.mcast,
    port: m.port - 1, // original RTP port
    sampleRate: m.sampleRate,
  }));

  for (const [id] of monitors) stopMonitoring(id);
  currentInterface = address;

  for (const stream of active) startMonitoring(stream);
}

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
  for (const [id] of monitors) stopMonitoring(id);
  process.exit(0);
});
