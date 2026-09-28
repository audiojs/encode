// requires: wasm-media-encoders
import { createMp3Encoder } from 'wasm-media-encoders'
import { info } from './info.js'

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
 * head() → Uint8Array: after flush, the start of the output to write over it: the Info (CBR) or Xing (VBR)
 *   frame with its final totals (frame and byte counts, seek TOC, the LAME tag's encoder delay and padding,
 *   which decoders trim for gapless playback), after the ID3 tag when one leads
 */
export default async function mp3(opts) {
	let { sampleRate, bitrate = 128, quality, channels, stream, meta, chapters } = opts
	if (!channels || channels < 1 || channels > 2) channels = 2
	let id3 = stream && (meta || chapters?.length) ? await import('../meta.js') : null
	// the last chapter ends at the end: known upfront from `frames`, else patched in by head()
	let end = opts.frames ? Math.round(opts.frames / sampleRate * 1000) : undefined
	let tag = id3?.id3Tag(meta, chapters, end), fed = 0, exact = null
	// the Info frame leads the audio: a placeholder of its final size, its totals known at the end
	let lame = info({ vbr: quality != null, quality }), lead0 = tag || new Uint8Array(0), placed = false, final = null
	// the output's length when known upfront and LAME codes at the input rate (it resamples rates it can't)
	let known = () => opts.frames != null && lame.header.sampleRate === sampleRate ? opts.frames : undefined

	let encoder = await createMp3Encoder()

	let cfg = { sampleRate, channels }
	if (quality != null) cfg.vbrQuality = quality
	else cfg.bitrate = bitrate

	encoder.configure(cfg)

	// WASM encoder has ~320MB/channel buffer limit.
	// Chunk large inputs in 1152*1024 (~1.18M) sample blocks.
	const CHUNK = 1152 * 1024

	return { encode: ch => lead(frames(ch)), flush, free, head }

	// the ID3 tag, then the Info frame, go out ahead of the first audio bytes
	function lead(b) {
		lame.scan(b)
		let pre = [tag, !placed && lame.header ? lame.frame(known()) : null].filter(Boolean)
		if (!pre.length) return b
		if (pre.length > 1 || pre[0] !== tag) placed = true
		tag = null
		let n = b.length; for (let p of pre) n += p.length
		let out = new Uint8Array(n), o = 0
		for (let p of [...pre, b]) { out.set(p, o); o += p.length }
		return out
	}

	function head() {
		if (!final) return exact
		let t = exact || lead0, out = new Uint8Array(t.length + final.length)
		out.set(t); out.set(final, t.length)
		return out
	}

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
		// LAME resamples rates it can't code: the padding counts output samples
		let h = lame.header
		if (placed && h) final = lame.frame(Math.round(fed * h.sampleRate / sampleRate), true)
		return raw
	}

	function free() {
		encoder = null
	}
}
