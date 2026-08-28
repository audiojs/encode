export interface AlacEncoderOptions {
	/** required */
	sampleRate: number
	/** 1-8 */
	channels: number
	/** 16, 20, 24, or 32. Default 16. */
	bitDepth?: 16 | 20 | 24 | 32
	/** samples per frame. Default 4096 (kALACDefaultFrameSize). */
	frameLength?: number
	/** skip the mixRes/predictor-order search loops (ALACEncoder::EncodeStereoFast). Default false. */
	fastMode?: boolean
}

export interface AlacEncoder {
	/** ALACSpecificConfig [+ ALACAudioChannelLayout for >2ch], big-endian, matching ALACEncoder::GetMagicCookie.
	 *  Live: reflects the current maxFrameBytes/avgBitRate each time it's read. */
	readonly cookie: Uint8Array
	readonly frameLength: number
	readonly maxFrameBytes: number
	/** always 0 — see encoder.js for why (matches the reference encoder's actual behavior) */
	readonly avgBitRate: number
	/**
	 * Feed samples; returns every frame that became complete.
	 * planar: one array per channel, all the same length.
	 * Float32Array is rounded, clamped, and scaled by 2**(bitDepth-1); Int32Array passes
	 * through unchanged — that's the bit-exact path.
	 */
	encode(planar: (Float32Array | Int32Array)[]): Uint8Array[]
	/** Encodes and returns the final, possibly-partial frame (or [] if nothing is queued). */
	flush(): Uint8Array[]
}

export function createAlacEncoder(opts: AlacEncoderOptions): AlacEncoder
