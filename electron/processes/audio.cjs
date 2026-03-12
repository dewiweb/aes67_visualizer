/**
 * Audio Playback Child Process
 * Handles RTP reception and audio output via Audify/RtAudio
 * Based on philhartung/aes67-monitor audio.js
 */

const dgram = require('dgram');

let rtAudio = null;
let client = null;
let streamOpen = false;
let currentArgs = null;

// Load audify (native module)
let RtAudio, RtAudioFormat, RtAudioApi;

function initAudify() {
  try {
    const audify = require('audify');
    RtAudio = audify.RtAudio;
    RtAudioFormat = audify.RtAudioFormat;
    RtAudioApi = audify.RtAudioApi;
    return true;
  } catch (e) {
    console.error('[Audio] Failed to load audify:', e.message);
    process.send({ type: 'error', message: 'Audio backend not available' });
    return false;
  }
}

function getAudioApi() {
  if (!RtAudioApi) return 0;

  switch (process.platform) {
    case 'darwin':
      return RtAudioApi.MACOSX_CORE;
    case 'win32':
      return RtAudioApi.WINDOWS_WASAPI;
    case 'linux': {
      // PipeWire exposes a PulseAudio API — prefer it over raw ALSA
      // which conflicts with PipeWire/PulseAudio and causes glitches.
      // Fall back to ALSA only if PULSE is not available.
      if (RtAudioApi.LINUX_PULSE !== undefined) {
        try {
          const test = new RtAudio(RtAudioApi.LINUX_PULSE);
          const devs = test.getDevices();
          if (devs && devs.length > 0) return RtAudioApi.LINUX_PULSE;
        } catch (_) {}
      }
      return RtAudioApi.LINUX_ALSA;
    }
    default:
      return RtAudioApi.UNSPECIFIED;
  }
}

function getDevices() {
  if (!RtAudio) return [];
  
  try {
    const audioApi = getAudioApi();
    const tempRtAudio = new RtAudio(audioApi);
    const devices = tempRtAudio.getDevices();
    
    return devices.filter(d => d.outputChannels > 0).map(d => ({
      id: d.id,
      name: d.name,
      outputChannels: d.outputChannels,
      inputChannels: d.inputChannels,
      sampleRates: d.sampleRates,
      isDefaultOutput: d.isDefaultOutput,
    }));
  } catch (e) {
    console.error('[Audio] getDevices error:', e.message);
    return [];
  }
}

function start(args) {
  if (!RtAudio || !RtAudioFormat) {
    process.send({ type: 'error', message: 'Audio not initialized' });
    return;
  }

  currentArgs = args;
  
  // Stop existing stream
  stop();

  client = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  client.on('error', (err) => {
    console.error(`[Audio] Socket error: ${err.message}`);
    process.send({ type: 'error', message: err.message });
  });

  client.on('listening', () => {
    try {
      client.addMembership(args.mcast, args.networkInterface);
      console.log(`[Audio] Joined ${args.mcast} on ${args.networkInterface}`);
    } catch (e) {
      console.error('[Audio] Multicast join error:', e.message);
    }
  });

  // Audio parameters
  const RING_SIZE    = 64;  // ring buffer slots (power of 2)
  const samplesPerPacket = Math.round((args.sampleRate / 1000) * parseFloat(args.ptime));
  const bytesPerSample   = args.codec === 'L24' ? 3 : 2;
  // +2 sample margin per slot: fractional ptime (e.g. 0.666ms) can yield 32 or 33 samples
  const maxSamplesPerSlot = samplesPerPacket + 2;
  const frameBytes        = maxSamplesPerSlot * 4; // stereo S16LE, worst-case slot size

  // Jitter buffer: ring of PCM slots + fill-flag + actual sample count per slot
  const ring         = Buffer.alloc(frameBytes * RING_SIZE); // zeroed = silence
  const ringFill     = new Uint8Array(RING_SIZE);             // 0=empty, 1=filled
  const ringActual   = new Uint16Array(RING_SIZE).fill(samplesPerPacket); // samples in slot

  let jitterBufferSize = args.bufferEnabled ? Math.max(2, args.bufferSize) : 2;
  jitterBufferSize = Math.min(jitterBufferSize, RING_SIZE >> 1);

  // Minimum samples per RtAudio write (RtAudio requirement)
  let outSampleFactor = 1;
  while (samplesPerPacket * outSampleFactor < 48) outSampleFactor++;
  outSampleFactor = Math.min(outSampleFactor, 4); // cap at 4×

  let nextSeq = -1; // next expected sequence number (-1 = not started)

  client.on('message', (buffer, remote) => {
    // Parse RTP header
    const firstByte  = buffer.readUInt8(0);
    const csrcCount  = firstByte & 0x0f;
    let   headerLength = 12 + csrcCount * 4;
    const extensionFlag = (firstByte >> 4) & 0x01;

    if (extensionFlag) {
      const extIndex       = 12 + csrcCount * 4;
      const extensionLength = buffer.readUInt16BE(extIndex + 2);
      headerLength += 4 + extensionLength * 4;
    }

    const payloadLength = buffer.length - headerLength;
    // Accept packets whose payload is a multiple of one interleaved frame (all channels × bytesPerSample)
    // Strict equality breaks on fractional ptime (e.g. 0.666ms → 32 or 33 samples depending on sender)
    const frameSize = bytesPerSample * args.channels;
    if (payloadLength <= 0 || payloadLength % frameSize !== 0) return;
    const actualSamples = payloadLength / frameSize;
    if (args.filter && remote.address !== args.filterAddr) return;

    const seqNum  = buffer.readUInt16BE(2);
    const slot    = seqNum & (RING_SIZE - 1); // fast modulo (power of 2)
    const slotOff = slot * frameBytes;
    ringActual[slot] = actualSamples; // store real sample count for this slot

    // Decode into ring slot — use actualSamples (real packet) not samplesPerPacket (ptime estimate)
    for (let s = 0; s < actualSamples; s++) {
      ring.writeUInt16LE(
        buffer.readUInt16BE((s * args.channels + args.ch1Map) * bytesPerSample + headerLength),
        slotOff + s * 4
      );
      ring.writeUInt16LE(
        buffer.readUInt16BE((s * args.channels + args.ch2Map) * bytesPerSample + headerLength),
        slotOff + s * 4 + 2
      );
    }
    ringFill[slot] = 1;

    if (nextSeq === -1) {
      // First packet: prime the jitter buffer with silence then start
      nextSeq = (seqNum - jitterBufferSize + 65536) & 0xFFFF;
      const silence = Buffer.alloc(actualSamples * 4);
      for (let j = 0; j < jitterBufferSize; j++) {
        try { rtAudio.write(silence); } catch (_) {}
      }
    }

    // Drain slots up to (but not including) current seqNum
    let drained = 0;
    while (nextSeq !== seqNum && drained < RING_SIZE) {
      const ns      = nextSeq & (RING_SIZE - 1);
      const off     = ns * frameBytes;
      const nBytes  = ringActual[ns] * 4;
      // Write slot data if filled, else silence (missing packet concealment)
      try {
        rtAudio.write(ringFill[ns] ? ring.subarray(off, off + nBytes) : Buffer.alloc(nBytes));
      } catch (_) {}
      ringFill[ns] = 0;
      nextSeq = (nextSeq + 1) & 0xFFFF;
      drained++;
    }

    // Output the current packet
    try {
      rtAudio.write(ring.subarray(slotOff, slotOff + actualSamples * 4));
    } catch (_) {}
    ringFill[slot] = 0;
    nextSeq = (seqNum + 1) & 0xFFFF;
  });

  // Initialize RtAudio
  const audioApi = getAudioApi();
  rtAudio = new RtAudio(audioApi);
  
  // Find output device
  const devices = rtAudio.getDevices();
  let deviceId = null;
  let defaultDevice = null;

  for (const device of devices) {
    if (args.audioDevice && 
        device.name === args.audioDevice.name &&
        device.outputChannels === args.audioDevice.outputChannels) {
      deviceId = device.id;
      break;
    }
    if (device.isDefaultOutput && device.outputChannels >= 2) {
      defaultDevice = device;
    }
  }

  if (deviceId === null && defaultDevice) {
    deviceId = defaultDevice.id;
  }

  if (deviceId === null) {
    process.send({ type: 'error', message: 'No audio output device found' });
    return;
  }

  try {
    const streamFrames = samplesPerPacket * outSampleFactor;
    console.log(`[Audio] API=${getAudioApi()} device=${deviceId} frames=${streamFrames} sr=${args.sampleRate} jitter=${jitterBufferSize}`);
    rtAudio.openStream(
      { deviceId, nChannels: 2, firstChannel: 0 },
      null,
      RtAudioFormat.RTAUDIO_SINT16,
      args.sampleRate,
      streamFrames,
      'AES67 Pro Monitor'
    );
    rtAudio.start();
    client.bind(args.port);
    streamOpen = true;
    
    process.send({ 
      type: 'status', 
      playing: true, 
      streamId: args.streamId,
      streamName: args.streamName 
    });
    
    console.log(`[Audio] Playing ${args.streamName} (${args.codec}/${args.sampleRate}/${args.channels}ch)`);
  } catch (e) {
    console.error('[Audio] Stream setup error:', e.message);
    process.send({ type: 'error', message: e.message });
  }
}

function stop() {
  if (streamOpen) {
    streamOpen = false;
    
    try {
      if (client) client.close();
    } catch (e) { /* ignore */ }
    
    try {
      if (rtAudio) {
        rtAudio.stop();
        rtAudio.clearOutputQueue();
        rtAudio.closeStream();
      }
    } catch (e) { /* ignore */ }
    
    client = null;
    
    process.send({ type: 'status', playing: false });
    console.log('[Audio] Playback stopped');
  }
}

// Initialize and handle messages
const success = initAudify();
if (success) {
  process.on('message', (msg) => {
    switch (msg.type) {
      case 'play':
        start(msg);
        break;
      case 'stop':
        stop();
        break;
      case 'get-devices':
        process.send({ type: 'devices', devices: getDevices() });
        break;
    }
  });
}

process.on('disconnect', () => {
  stop();
  process.exit(0);
});
