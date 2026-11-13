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
		;(float ? f32 : bitDepth === 24 ? i24 : i16)(ch, nch, len, buf)

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

// Interleave channels into little-endian PCM. One strided loop per channel and sample type;
// typed-array views write native (little-endian) order, DataView only on a big-endian host.
// Integer PCM: scale by 2^(bits-1), round half up as floor(x + 0.5), several times faster than V8's
// Math.round and equal to it for every float32 sample (differs only at 0.5 - 2^-54), clip to the codes.
const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

// Float to integer PCM: round(x · 2^(bits-1)), clipped to the codes (ffmpeg, libsndfile; the family's decoders
// divide by 2^(bits-1)), so decode → encode returns every code. floor(x + 0.5): Math.round for every float32
// sample, several times faster in V8.
function q16(s) { let v = Math.floor(s * 0x8000 + 0.5); return v > 0x7FFF ? 0x7FFF : v < -0x8000 ? -0x8000 : v }
function i16(ch, nch, len, buf) {
	if (nch === 2 && ch[0] instanceof Float32Array && ch[1] instanceof Float32Array && i16Stereo(ch, len, buf)) return
	if (!LE) {
		let dv = new DataView(buf.buffer)
		for (let c = 0; c < nch; c++) for (let x = ch[c], i = 0, o = c * 2; i < len; i++, o += nch * 2) {
			let s = x[i]
			dv.setInt16(o, q16(s), true)
		}
		return
	}
	let out = new Int16Array(buf.buffer, 0, len * nch)
	for (let c = 0; c < nch; c++) for (let x = ch[c], i = 0, o = c; i < len; i++, o += nch) {
		let s = x[i]
		out[o] = q16(s)
	}
}

// wav-encode.wat, compiled by wat2wasm (526 bytes): i16's loops for two float32 channels in WebAssembly SIMD, the same
// float64 ops, the same bytes; twice as fast with the copies in and out
const I16 = new Uint8Array([
	0,97,115,109,1,0,0,0,1,8,1,96,4,127,127,127,127,0,3,2,1,0,5,3,1,0,1,7,16,2,6,109,101,109,111,114,121,2,0,3,105,49,
	54,0,0,10,222,3,1,219,3,3,1,127,6,123,1,127,68,0,0,0,0,0,0,224,64,253,20,33,7,68,0,0,0,0,0,0,224,63,253,20,33,8,32,
	1,32,0,107,33,1,32,0,32,3,65,124,113,65,2,116,106,33,4,2,64,32,0,32,4,79,13,0,3,64,32,0,253,0,4,0,33,5,32,0,32,1,
	106,253,0,4,0,33,6,32,5,253,95,32,7,253,242,1,32,8,253,240,1,253,117,253,252,1,32,5,32,5,253,13,8,9,10,11,12,13,14,
	15,0,1,2,3,4,5,6,7,253,95,32,7,253,242,1,32,8,253,240,1,253,117,253,252,1,253,13,0,1,2,3,4,5,6,7,16,17,18,19,20,21,
	22,23,33,9,32,6,253,95,32,7,253,242,1,32,8,253,240,1,253,117,253,252,1,32,6,32,6,253,13,8,9,10,11,12,13,14,15,0,1,2,
	3,4,5,6,7,253,95,32,7,253,242,1,32,8,253,240,1,253,117,253,252,1,253,13,0,1,2,3,4,5,6,7,16,17,18,19,20,21,22,23,33,
	10,32,2,32,9,32,10,253,133,1,32,9,32,10,253,133,1,253,13,0,1,8,9,2,3,10,11,4,5,12,13,6,7,14,15,253,11,4,0,32,0,65,
	16,106,33,0,32,2,65,16,106,33,2,32,0,32,4,73,13,0,11,11,32,4,32,3,65,3,113,65,2,116,106,33,4,2,64,32,0,32,4,79,13,0,
	3,64,32,0,42,2,0,187,68,0,0,0,0,0,0,224,64,162,68,0,0,0,0,0,0,224,63,160,156,252,2,33,11,32,2,65,255,255,1,65,128,
	128,126,32,11,32,11,65,128,128,126,72,27,32,11,65,255,255,1,74,27,59,1,0,32,0,32,1,106,42,2,0,187,68,0,0,0,0,0,0,
	224,64,162,68,0,0,0,0,0,0,224,63,160,156,252,2,33,11,32,2,65,255,255,1,65,128,128,126,32,11,32,11,65,128,128,126,72,
	27,32,11,65,255,255,1,74,27,59,1,2,32,0,65,4,106,33,0,32,2,65,4,106,33,2,32,0,32,4,73,13,0,11,11,11,
])
let simd // the kernel's exports where WebAssembly SIMD runs, null elsewhere

/** Two float32 channels of len samples into buf by the kernel: false where it does not run (or a channel is short) */
function i16Stereo(ch, len, buf) {
	if (ch[0].length !== len || ch[1].length !== len) return false
	if (simd === undefined) try { simd = new WebAssembly.Instance(new WebAssembly.Module(I16)).exports } catch { simd = null }
	if (!simd) return false
	let mem = simd.memory, need = len * 12
	if (need > mem.buffer.byteLength) mem.grow(Math.ceil((need - mem.buffer.byteLength) / 65536))
	let f32 = new Float32Array(mem.buffer, 0, len * 2)
	f32.set(ch[0]); f32.set(ch[1], len)
	simd.i16(0, len * 4, len * 8, len)
	buf.set(new Uint8Array(mem.buffer, len * 8, len * 4))
	return true
}

function i24(ch, nch, len, buf) {
	for (let c = 0; c < nch; c++) for (let x = ch[c], i = 0, o = c * 3; i < len; i++, o += nch * 3) {
		let s = x[i]
		let v = Math.floor(s * 0x800000 + 0.5)
		v = v > 0x7FFFFF ? 0x7FFFFF : v < -0x800000 ? -0x800000 : v
		buf[o] = v & 0xFF
		buf[o + 1] = (v >> 8) & 0xFF
		buf[o + 2] = (v >> 16) & 0xFF
	}
}

function f32(ch, nch, len, buf) {
	if (!LE) {
		let dv = new DataView(buf.buffer)
		for (let c = 0; c < nch; c++) for (let x = ch[c], i = 0, o = c * 4; i < len; i++, o += nch * 4) dv.setFloat32(o, x[i], true)
		return
	}
	let out = new Float32Array(buf.buffer, 0, len * nch)
	for (let c = 0; c < nch; c++) for (let x = ch[c], i = 0, o = c; i < len; i++, o += nch) out[o] = x[i]
}
