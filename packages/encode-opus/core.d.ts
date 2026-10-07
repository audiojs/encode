export const OPUS_RATE: 48000;
/** Samples per channel in one 20 ms frame at 48 kHz */
export const FRAME: 960;

export interface OpusEncoderOptions {
  /** 1 or 2 (default 1) */
  channels?: number;
  /** kbps (default 64) */
  bitrate?: number;
  application?: 'audio' | 'voip' | 'lowdelay';
  /** 0-10 (default 10) */
  complexity?: number;
}

export interface OpusPacketEncoder {
  channels: number;
  /** Encoder delay in 48 kHz samples: the Ogg pre-skip / Matroska CodecDelay */
  lookahead: number;
  /** Encode one frame of interleaved float PCM at 48 kHz (FRAME * channels samples) into an Opus packet */
  encode(frame: Float32Array): Uint8Array;
  free(): void;
}

/** Initialize libopus WASM and create a raw packet encoder. */
export function createOpusEncoder(opts?: OpusEncoderOptions): Promise<OpusPacketEncoder>;

export interface OpusResampler {
  /** Planar chunk at the input rate → interleaved 48 kHz float, as much as is ready */
  write(chunk: Float32Array[]): Float32Array;
  /** The rest: all writes and the flush hold round(n · 48000 / sampleRate) samples per channel */
  flush(): Float32Array;
}

/** Resample chunks to 48 kHz as one stream (polyphase FIR): any chunking gives the samples one chunk gives. */
export function createResampler(sampleRate: number, channels?: number): OpusResampler;

/** Resample a whole signal, planar float channels, to interleaved 48 kHz (passthrough at 48 kHz). */
export function toOpusRate(channels: Float32Array[], sampleRate: number): Float32Array;
