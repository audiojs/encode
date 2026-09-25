/**
 * AIFF encoder — browser + Node, zero dependencies
 * @param {Object} opts
 * @param {number} opts.sampleRate
 * @param {number} [opts.bitDepth=16] - 16 or 24
 * @param {boolean} [opts.stream] - emit the header and samples as they are encoded, sizes unknown
 *   (0xFFFFFFFF, read to the end) until head() gives the exact header; `meta` rides in an ID3 chunk
 * @param {number} [opts.frames] - with stream: the exact length, when known upfront: the header goes out exact
 * @returns {{ encode, flush, free, head }}
 */
export default async function aiff(opts) {
	let rate = opts.sampleRate, depth = opts.bitDepth || 16, stream = opts.stream
	if (depth !== 16 && depth !== 24)
		throw Error('Unsupported bitDepth: ' + depth + ' (use 16 or 24)')
	let bytesPerSample = depth >> 3
	let chunks = [], totalBytes = 0, numFrames = 0, nCh = 0
	let id3 = stream && opts.meta ? (await import('./meta.js')).id3Chunk(opts.meta) : null
	let sent = false, exact = null

	return { encode, flush, free, head }

	function encode(channels) {
		let cn = channels.length, len = channels[0].length
		if (!nCh) nCh = cn
		let buf = new Uint8Array(len * cn * bytesPerSample)
		let dv = new DataView(buf.buffer)
		let pos = 0

		if (depth === 16) {
			for (let i = 0; i < len; i++) {
				for (let c = 0; c < cn; c++) {
					let s = channels[c][i]
					s = s < -1 ? -1 : s > 1 ? 1 : s
					dv.setInt16(pos, Math.round(s * 0x7FFF), false)
					pos += 2
				}
			}
		} else {
			for (let i = 0; i < len; i++) {
				for (let c = 0; c < cn; c++) {
					let s = channels[c][i]
					s = s < -1 ? -1 : s > 1 ? 1 : s
					let v = Math.round(s * 0x7FFFFF)
					buf[pos] = (v >> 16) & 0xFF
					buf[pos + 1] = (v >> 8) & 0xFF
					buf[pos + 2] = v & 0xFF
					pos += 3
				}
			}
		}

		numFrames += len
		totalBytes += buf.length
		if (stream) {
			if (sent) return buf
			sent = true
			let h = header(opts.frames), out = new Uint8Array(h.length + buf.length)
			out.set(h); out.set(buf, h.length)
			return out
		}
		chunks.push(buf)
		return new Uint8Array(0)
	}

	// FORM, COMM, [ID3], SSND header for `frames` sample frames; null: sizes 0xFFFFFFFF (unknown, read to the end)
	function header(frames) {
		let ch = nCh || opts.channels || 1, x = id3?.length || 0, bytes = (frames ?? 0) * ch * bytesPerSample
		let hdr = new Uint8Array(12 + 26 + x + 16), dv = new DataView(hdr.buffer), p = 0
		let ssndSize = bytes + 8, formSize = 4 + 26 + x + 8 + ssndSize + (bytes & 1)
		let fit = frames != null && formSize <= 0xFFFFFFFF

		// FORM
		str('FORM'); dv.setUint32(p, fit ? formSize : 0xFFFFFFFF, false); p += 4; str('AIFF')

		// COMM
		str('COMM'); dv.setUint32(p, 18, false); p += 4
		dv.setInt16(p, ch, false); p += 2
		dv.setUint32(p, fit ? frames : 0xFFFFFFFF, false); p += 4
		dv.setInt16(p, depth, false); p += 2
		writeF80(dv, p, rate); p += 10

		// ID3 (streamed metadata), then SSND
		if (id3) { hdr.set(id3, p); p += x }
		str('SSND'); dv.setUint32(p, fit ? ssndSize : 0xFFFFFFFF, false); p += 4
		dv.setUint32(p, 0, false); p += 4
		dv.setUint32(p, 0, false); p += 4
		return hdr

		function str(s) { for (let i = 0; i < 4; i++) hdr[p++] = s.charCodeAt(i) }
	}

	/** Exact header for the streamed bytes (same length as the one emitted), once flushed. */
	function head() { return exact }

	function flush() {
		if (!nCh) nCh = opts.channels || 1
		if (stream) {
			let h = sent ? null : (sent = true, header(opts.frames)), pad = totalBytes & 1 ? new Uint8Array(1) : null
			exact = opts.frames === numFrames ? null : header(numFrames)  // the declared length held: nothing to patch
			if (!h) return pad || new Uint8Array(0)
			let out = new Uint8Array(h.length + (pad ? 1 : 0)); out.set(h); return out
		}

		let hdr = header(numFrames)
		let file = new Uint8Array(hdr.length + totalBytes + (totalBytes & 1))  // chunks pad to even
		file.set(hdr)
		let off = hdr.length
		for (let c of chunks) { file.set(c, off); off += c.length }
		return file
	}

	function free() { chunks = null }
}

// 80-bit IEEE 754 extended precision (big-endian)
function writeF80(dv, off, rate) {
	if (!rate) { for (let i = 0; i < 10; i++) dv.setUint8(off + i, 0); return }
	let e = Math.floor(Math.log2(rate))
	let shift = 63 - e
	// mantissa high 32 bits: rate * 2^(shift-32), low 32 bits: remainder
	let hi = (rate * Math.pow(2, shift - 32)) >>> 0
	let lo = (rate * Math.pow(2, shift) - hi * 4294967296) >>> 0
	dv.setUint16(off, 16383 + e, false)
	dv.setUint32(off + 2, hi, false)
	dv.setUint32(off + 6, lo, false)
}
