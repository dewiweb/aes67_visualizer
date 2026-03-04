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
    case 'linux':
      return RtAudioApi.LINUX_ALSA;
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
  const bufferSize = 1024;
  const samplesPerPacket = Math.round((args.sampleRate / 1000) * args.ptime);
  const bytesPerSample = args.codec === 'L24' ? 3 : 2;
  const pcmDataSize = samplesPerPacket * bytesPerSample * args.channels;
  const pcmL16out = Buffer.alloc(samplesPerPacket * 4 * bufferSize);

  let jitterBufferSize = args.bufferEnabled ? args.bufferSize : 0;
  let outSampleFactor = 1;
  let seqInternal = -1;

  // Ensure minimum 48 samples per write
  while (samplesPerPacket * outSampleFactor < 48) {
    outSampleFactor++;
  }

  if (outSampleFactor > 1 && outSampleFactor > jitterBufferSize) {
    jitterBufferSize = outSampleFactor;
  }

  client.on('message', (buffer, remote) => {
    // Parse RTP header
    const firstByte = buffer.readUInt8(0);
    const csrcCount = firstByte & 0x0f;
    let headerLength = 12 + csrcCount * 4;
    const extensionFlag = (firstByte >> 4) & 0x01;

    // Handle RTP extension header
    if (extensionFlag) {
      const extIndex = 12 + csrcCount * 4;
      const extensionLength = buffer.readUInt16BE(extIndex + 2);
      headerLength += 4 + extensionLength * 4;
    }

    // Validate packet size
    if (buffer.length !== pcmDataSize + headerLength) {
      return;
    }

    // Source filter (if specified)
    if (args.filter && remote.address !== args.filterAddr) {
      return;
    }

    const seqNum = buffer.readUInt16BE(2);
    const bufferIndex = (seqNum % bufferSize) * samplesPerPacket * 4;

    // Convert to 16-bit stereo output
    for (let sample = 0; sample < samplesPerPacket; sample++) {
      // Left channel
      pcmL16out.writeUInt16LE(
        buffer.readUInt16BE(
          (sample * args.channels + args.ch1Map) * bytesPerSample + headerLength
        ),
        sample * 4 + bufferIndex
      );
      // Right channel
      pcmL16out.writeUInt16LE(
        buffer.readUInt16BE(
          (sample * args.channels + args.ch2Map) * bytesPerSample + headerLength
        ),
        sample * 4 + bufferIndex + 2
      );
    }

    if (seqInternal !== -1) {
      if (outSampleFactor === 1 || seqInternal % outSampleFactor === 0) {
        const outBufIndex = seqInternal * samplesPerPacket * 4;
        const outBuf = pcmL16out.subarray(
          outBufIndex,
          outBufIndex + samplesPerPacket * 4 * outSampleFactor
        );
        try {
          rtAudio.write(outBuf);
        } catch (e) {
          // Buffer overflow, ignore
        }
      }
      seqInternal = (seqInternal + 1) % bufferSize;
    } else {
      // Initialize sequence
      seqInternal = (seqNum - jitterBufferSize + bufferSize) % bufferSize;
      
      // Fill jitter buffer with silence
      for (let j = 0; j < jitterBufferSize; j++) {
        try {
          rtAudio.write(Buffer.alloc(samplesPerPacket * 4 * outSampleFactor));
        } catch (e) {
          // Ignore
        }
      }
    }
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
    rtAudio.openStream(
      { deviceId, nChannels: 2, firstChannel: 0 },
      null,
      RtAudioFormat.RTAUDIO_SINT16,
      args.sampleRate,
      samplesPerPacket * outSampleFactor,
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
