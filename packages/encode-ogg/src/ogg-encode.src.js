// requires: wasm-media-encoders
import { createOggEncoder } from 'wasm-media-encoders'

/**
 * OGG Vorbis encoder — browser + Node (WASM)
 *
 * @param {Object} opts
 * @param {number} opts.sampleRate - required
 * @param {number} [opts.quality=3] - quality level -1 to 10
 * @param {number} [opts.channels] - 1 or 2
 * @param {boolean} [opts.stream] - with `meta`: tags go into the comment header as the stream goes
 * @returns {Promise<{ encode, flush, free }>}
 */
export default async function ogg(opts) {
	let { sampleRate, quality = 3, channels, stream, meta } = opts
	let enc = await createOggEncoder()
	let nch = channels || 0
	let tag = stream && meta ? (await import('../meta.js')).metaStream(meta) : b => b

	if (nch) enc.configure({ sampleRate, channels: nch, vbrQuality: quality })

	return { encode: ch => tag(encode(ch)), flush: () => tag(flush()), free }

	function encode(ch) {
		if (!nch) {
			nch = ch.length
			enc.configure({ sampleRate, channels: nch, vbrQuality: quality })
		}
		let raw = enc.encode(ch)
		return new Uint8Array(raw)
	}

	function flush() {
		let raw = enc.finalize()
		return new Uint8Array(raw)
	}

	function free() {
		enc = null
	}
}
