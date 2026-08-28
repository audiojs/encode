// Generated from the audio.js manifest (params metadata is the source of truth).
// Regenerate: node tools/dts.js in @audio/compile. Do not edit by hand.

/** Automatable number — scalar, `t => value` fn, or breakpoint curve {t, v} */
type Auto = number | ((t: number) => number) | { t: number[], v: number[] }
/** Per-block param values as delivered by hosts (numbers arrive as 1-length Float32Array) */
type Live = Record<string, Float32Array | string | boolean>
type Ctx = { sampleRate: number, maxBlockSize: number, maxChannels: number, currentTime: number, duration?: number, events?: readonly any[], emit?: (name: string, ...args: any[]) => void, [k: string]: unknown }
type Process = (inputs: Float32Array[][], outputs: Float32Array[][], params: Live) => void

/** Codec plugin 'alac' — extends audio()'s save() targets (M4A container, ALAC codec) */
export declare const alac: {
	codec: 'alac'
	encode(opts: { sampleRate: number, channels?: number, bitDepth?: 16 | 20 | 24 | 32, frameLength?: number, fastMode?: boolean }): Promise<(chunk?: Float32Array[] | Int32Array[]) => Promise<Uint8Array>>
}
