// requires: wasm-media-encoders
import { createMp3Encoder } from 'wasm-media-encoders'

/**
 * MP3 encoder — browser + Node, via wasm-media-encoders
 *
 * @param {Object} opts
 * @param {number} opts.sampleRate - required
 * @param {number} [opts.bitrate=128] - kbps (CBR)
 * @param {number} [opts.quality] - 0-9 VBR quality (0=best, 9=worst). If set, uses VBR mode.
 * @param {number} [opts.channels] - 1 or 2
 * @param {boolean} [opts.stream] - with `meta` / `chapters` ([{ time, title }]): the ID3v2 tag leads
 *   the stream; the last chapter's end is unknown until head() gives the finished tag, unless
 * @param {number} [opts.frames] - the exact length is known upfront
 * @returns {{ encode, flush, free, head }}
 *
 * encode(channels: Float32Array[]) → Uint8Array
 * flush() → Uint8Array
 * free() → void
 */
export default async function mp3(opts) {
	let { sampleRate, bitrate = 128, quality, channels, stream, meta, chapters } = opts
	if (!channels || channels < 1 || channels > 2) channels = 2
	let id3 = stream && (meta || chapters?.length) ? await import('../meta.js') : null
	// the last chapter ends at the end: known upfront from `frames`, else patched in by head()
	let end = opts.frames ? Math.round(opts.frames / sampleRate * 1000) : undefined
	let tag = id3?.id3Tag(meta, chapters, end), fed = 0, exact = null

	let encoder = await createMp3Encoder()

	let cfg = { sampleRate, channels }
	if (quality != null) cfg.vbrQuality = quality
	else cfg.bitrate = bitrate

	encoder.configure(cfg)

	// WASM encoder has ~320MB/channel buffer limit.
	// Chunk large inputs in 1152*1024 (~1.18M) sample blocks.
	const CHUNK = 1152 * 1024

	return { encode: ch => lead(frames(ch)), flush, free, head }

	// the tag goes out ahead of the first bytes
	function lead(b) {
		if (!tag) return b
		let out = new Uint8Array(tag.length + b.length)
		out.set(tag); out.set(b, tag.length)
		tag = null
		return out
	}

	function head() { return exact }

	function frames(ch) {
		let n = ch[0].length
		fed += n
		if (n <= CHUNK) {
			let raw = encoder.encode(ch)
			return new Uint8Array(raw)
		}
		let parts = []
		for (let i = 0; i < n; i += CHUNK) {
			let end = Math.min(i + CHUNK, n)
			let slice = ch.map(c => c.subarray(i, end))
			let raw = encoder.encode(slice)
			if (raw.length) parts.push(new Uint8Array(raw))
		}
		let total = 0
		for (let p of parts) total += p.length
		let out = new Uint8Array(total)
		let off = 0
		for (let p of parts) { out.set(p, off); off += p.length }
		return out
	}

	function flush() {
		let raw = lead(new Uint8Array(encoder.finalize()))
		let last = Math.round(fed / sampleRate * 1000)
		if (id3 && chapters?.length && last !== end) exact = id3.id3Tag(meta, chapters, last)
		return raw
	}

	function free() {
		encoder = null
	}
}
