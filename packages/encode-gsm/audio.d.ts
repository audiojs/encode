export declare const gsm: {
  codec: 'gsm'
  encode(opts: { sampleRate?: 8000, channels?: 1 }): Promise<(chunk?: Float32Array[] | Float32Array) => Uint8Array>
}
