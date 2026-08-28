/**
 * ALAC (Apple Lossless) encoder — ecosystem shape, browser + Node.
 * Wraps ./core.js (the pure-JS ALAC frame encoder) and mp4-muxes the frames into a
 * complete M4A file via @audio/encode-mp4/mux (dynamic import — not a hard dependency;
 * see package.json).
 *
 * @param {Object} opts
 * @param {number} opts.sampleRate - required
 * @param {number} [opts.channels] - 1-8; inferred from the first encode() call if omitted
 * @param {number} [opts.bitDepth=16] - 16, 20, 24, or 32
 * @param {number} [opts.frameLength=4096]
 * @param {boolean} [opts.fastMode=false]
 * @param {import('@audio/encode-mp4/mux').Mp4Meta} [opts.meta]
 * @param {import('@audio/encode-mp4/mux').Mp4Chapter[]} [opts.chapters]
 * @param {import('@audio/encode-mp4/mux').MuxOptions['brand']} [opts.brand]
 * @returns {{ encode, flush, free }}
 *
 * encode(channels: Float32Array[] | Int32Array[]) -> Uint8Array(0) (buffered; frames land in flush())
 * flush() -> Uint8Array (complete M4A file: ftyp + moov + mdat)
 * free() -> void
 */
import { createAlacEncoder } from './core.js'

export default async function alac(opts) {
	let { sampleRate, channels, bitDepth = 16, frameLength, fastMode, meta, chapters, brand } = opts
	if (!sampleRate) throw Error('ALAC: sampleRate is required')

	let enc = null
	let samples = [], durations = []
	let totalSamples = 0

	return { encode, flush, free }

	function ensure(nch) {
		if (enc) return
		channels = channels || nch
		enc = createAlacEncoder({ sampleRate, channels, bitDepth, frameLength, fastMode })
	}

	// encode(channels) -> Uint8Array(0); frames are buffered until flush()
	function encode(ch) {
		ensure(ch.length)
		totalSamples += ch[0].length
		let frames = enc.encode(ch)
		for (let f of frames) { samples.push(f); durations.push(enc.frameLength) }
		return new Uint8Array(0)
	}

	// flush() -> Uint8Array (complete M4A file)
	async function flush() {
		if (!enc) return new Uint8Array(0)
		let fullFrames = samples.length
		let tail = enc.flush()
		for (let f of tail) { samples.push(f); durations.push(totalSamples - fullFrames * enc.frameLength) }

		let out = new Uint8Array(0)
		if (samples.length) {
			let { mux } = await import('@audio/encode-mp4/mux')
			out = mux(
				{ codec: 'alac', sampleRate, channels, samples, durations, config: enc.cookie },
				{ brand, meta, chapters },
			)
		}
		free()
		return out
	}

	function free() { enc = null; samples = null; durations = null }
}
