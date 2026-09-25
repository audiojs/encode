/**
 * WAV encoder — pure JS, browser + Node
 *
 * @param {Object} opts
 * @param {number} opts.sampleRate
 * @param {number} [opts.bitDepth=16] - 16 or 24 (int PCM), or 32 (float)
 * @param {boolean} [opts.stream] - emit the header and PCM as they are encoded. Sizes are unknown
 *   meanwhile (0xFFFFFFFF: read to the end); head() gives the exact header to write over the start,
 *   RF64 past 4 GB (EBU Tech 3306: a JUNK chunk reserved for ds64). Metadata goes in the header.
 * @param {number} [opts.frames] - with stream: the exact length, when known upfront: the header goes out
 *   exact (a canonical header, no RF64 reserve under 4 GB), head() has nothing to add
 * @param {object} [opts.meta] @param {object[]} [opts.markers] @param {object[]} [opts.regions] - with stream
 * @returns {{ encode, flush, free, head }}
 */
export default async function wav(opts) {
	let { sampleRate, bitDepth = 16, stream } = opts
	if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32)
		throw Error('Unsupported bitDepth: ' + bitDepth + ' (use 16, 24, or 32)')
	let float = bitDepth === 32
	let bps = bitDepth >> 3
	let fmt = float ? 3 : 1
	let nch = 0
	let chunks = []
	let size = 0
	let extras = stream && (opts.meta || opts.markers?.length || opts.regions?.length)
		? (await import('./meta.js')).metaChunks(opts) : []
	let sent = false, exact = null, known = null  // known: the data size the streamed header declared

	return { encode, flush, free, head }

	// encode(channels: Float32Array[]) → Uint8Array (raw PCM chunk)
	function encode(ch) {
		if (!nch) nch = ch.length
		let len = ch[0].length
		let buf = new Uint8Array(len * nch * bps)
		let dv = new DataView(buf.buffer)
		let off = 0

		for (let i = 0; i < len; i++) {
			for (let c = 0; c < nch; c++) {
				let s = ch[c][i]
				if (float) {
					dv.setFloat32(off, s, true)
				} else {
					// clamp to [-1, 1], scale to signed int
					s = s < -1 ? -1 : s > 1 ? 1 : s
					if (bitDepth === 24) {
						let v = Math.round(s * 0x7FFFFF)
						buf[off] = v & 0xFF
						buf[off + 1] = (v >> 8) & 0xFF
						buf[off + 2] = (v >> 16) & 0xFF
					} else {
						dv.setInt16(off, Math.round(s * 0x7FFF), true)
					}
				}
				off += bps
			}
		}

		size += buf.length
		if (stream) {
			if (sent) return buf
			sent = true
			let h = header(declared()), out = new Uint8Array(h.length + buf.length)
			out.set(h); out.set(buf, h.length)
			return out
		}
		chunks.push(buf)
		return new Uint8Array(0)
	}

	// The data size the streamed header declares: the exact one when `frames` says it upfront and it
	// fits RIFF's 32 bits, else 0xFFFFFFFF (unknown: read to the end) with 28 bytes reserved for ds64
	function declared() {
		let ch = nch || opts.channels || 1, d = opts.frames != null ? opts.frames * ch * bps : null
		return known = d != null && d + 1024 <= 0xFFFFFFFF ? d : null
	}

	// Streamed header: RIFF, [JUNK: 28 bytes reserved for ds64], fmt, metadata, data. `data` is the
	// data size, or 0xFFFFFFFF while unknown; past 32 bits it becomes RF64 with a ds64 chunk.
	function header(data) {
		let x = 0, junk = known == null ? 36 : 0
		for (let e of extras) x += e.length
		let h = new Uint8Array(12 + junk + 24 + x + 8), dv = new DataView(h.buffer)
		let ch = nch || opts.channels || 1, pad = data & 1, fixed = data !== 0xFFFFFFFF
		let riff = fixed ? h.length - 8 + data + pad : 0xFFFFFFFF
		let rf64 = fixed && riff > 0xFFFFFFFF && junk
		dv.setUint32(0, rf64 ? 0x52463634 : 0x52494646)       // "RF64" | "RIFF"
		dv.setUint32(4, rf64 || riff > 0xFFFFFFFF ? 0xFFFFFFFF : riff, true)
		dv.setUint32(8, 0x57415645)                           // "WAVE"
		if (junk) {
			dv.setUint32(12, rf64 ? 0x64733634 : 0x4A554E4B)    // "ds64" | "JUNK"
			dv.setUint32(16, 28, true)
			if (rf64) { setU64(dv, 20, riff); setU64(dv, 28, data); setU64(dv, 36, data / (ch * bps)) }
		}
		fmtChunk(dv, 12 + junk, ch)
		let off = 36 + junk
		for (let e of extras) { h.set(e, off); off += e.length }
		dv.setUint32(off, 0x64617461)                         // "data"
		dv.setUint32(off + 4, rf64 || data > 0xFFFFFFFF ? 0xFFFFFFFF : data, true)
		return h
	}

	function fmtChunk(dv, o, ch) {
		dv.setUint32(o, 0x666D7420)                           // "fmt "
		dv.setUint32(o + 4, 16, true)                         // chunk size
		dv.setUint16(o + 8, fmt, true)                        // audio format
		dv.setUint16(o + 10, ch, true)                        // channels
		dv.setUint32(o + 12, sampleRate, true)                // sample rate
		dv.setUint32(o + 16, sampleRate * ch * bps, true)     // byte rate
		dv.setUint16(o + 20, ch * bps, true)                  // block align
		dv.setUint16(o + 22, bitDepth, true)                  // bits per sample
	}

	/** Exact header for the streamed bytes (same length as the one emitted), once flushed. */
	function head() { return exact }

	// flush() → Uint8Array (complete WAV file with RIFF header; streamed: the pad byte, if any)
	function flush() {
		if (stream) {
			let h = sent ? null : (sent = true, header(declared()))
			exact = known === size ? null : header(size)  // the declared size held: nothing to patch
			let pad = size & 1 ? new Uint8Array(1) : null
			if (!h) return pad || new Uint8Array(0)
			if (!pad) return h
			let out = new Uint8Array(h.length + 1); out.set(h); return out
		}
		let out = new Uint8Array(44 + size + (size & 1))  // RIFF chunks pad to even
		let dv = new DataView(out.buffer)

		// RIFF header
		dv.setUint32(0, 0x52494646)                  // "RIFF"
		dv.setUint32(4, 36 + size + (size & 1), true) // file size - 8
		dv.setUint32(8, 0x57415645)                   // "WAVE"

		// fmt chunk
		dv.setUint32(12, 0x666D7420)                  // "fmt "
		dv.setUint32(16, 16, true)                    // chunk size
		dv.setUint16(20, fmt, true)                   // audio format
		dv.setUint16(22, nch || 1, true)              // channels
		dv.setUint32(24, sampleRate, true)            // sample rate
		let ch = nch || 1
		dv.setUint32(28, sampleRate * ch * bps, true) // byte rate
		dv.setUint16(32, ch * bps, true)              // block align
		dv.setUint16(34, bitDepth, true)              // bits per sample

		// data chunk
		dv.setUint32(36, 0x64617461)                  // "data"
		dv.setUint32(40, size, true)                  // data size

		// copy PCM data
		let off = 44
		for (let i = 0; i < chunks.length; i++) {
			out.set(chunks[i], off)
			off += chunks[i].length
		}

		return out
	}

	function free() {
		chunks = null
		size = 0
	}
}

function setU64(dv, o, v) { dv.setUint32(o, v % 0x100000000, true); dv.setUint32(o + 4, Math.floor(v / 0x100000000), true) }
