/**
 * audio-processor.js — AudioWorklet processor for real-time PCM capture
 * Captures raw Float32 audio and converts to Int16 PCM for Deepgram
 */

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 50ms per chunk — the low end of Deepgram's recommended 20-100ms for live
    // audio, so spoken words reach the recogniser about as fast as the network
    // allows. (Was 256ms as a fixed 4096 samples, then 100ms; 50ms halves the
    // remaining chunking latency.) `sampleRate` is a global of the worklet scope.
    this._bufferSize = Math.round(sampleRate / 20);
    this._buffer = new Float32Array(this._bufferSize);
    this._bufferIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // The node is created with channelCount 1 / 'explicit', so the browser has
    // already down-mixed mic + system audio to mono here.
    const channelData = input[0];
    if (!channelData) return true;

    for (let i = 0; i < channelData.length; i++) {
      this._buffer[this._bufferIndex++] = channelData[i];

      if (this._bufferIndex >= this._bufferSize) {
        // Convert Float32 to Int16 PCM
        const int16 = new Int16Array(this._bufferSize);
        for (let j = 0; j < this._bufferSize; j++) {
          const s = Math.max(-1, Math.min(1, this._buffer[j]));
          int16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        this.port.postMessage(int16.buffer, [int16.buffer]);
        this._buffer = new Float32Array(this._bufferSize);
        this._bufferIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
