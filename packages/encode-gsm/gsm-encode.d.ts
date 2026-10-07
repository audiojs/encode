export interface GSMEncoderOptions {
  /** 8000: GSM 06.10's only rate */
  sampleRate?: 8000
  /** 1: GSM 06.10 is mono */
  channels?: 1
}

export interface GSMEncoder {
  /** whole 33-byte frames as 160 samples fill each */
  encode(channels: Float32Array[] | Float32Array): Uint8Array
  /** the last partial frame, zero-padded */
  flush(): Uint8Array
  free(): void
}

/** GSM 06.10 full-rate encoder (libgsm 1.0.22, WASM): raw frames, as SoX's .gsm */
export default function gsm(opts?: GSMEncoderOptions): Promise<GSMEncoder>
