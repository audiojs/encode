/**
 * GSM 06.10 full-rate encoder: libgsm 1.0.22 (Degener & Bormann, TU Berlin) compiled to WASM.
 * 160 samples at 8 kHz, mono, into each 33-byte frame (13 kbit/s): raw frames, as SoX's .gsm and RTP payload 3.
 *
 * let enc = await gsm({ sampleRate: 8000 })
 * let bytes = enc.encode([samples])   // whole frames as they fill
 * let last = enc.flush()              // the last one, zero-padded
 *
 * @param {Object} opts
 * @param {number} opts.sampleRate - 8000: GSM's only rate
 * @returns {Promise<{ encode, flush, free }>}
 */
import createGSM from './src/gsm.wasm.js'

const FRAME = 33, N = 160
let _modP

async function getMod() {
	if (_modP) return _modP
	let p = _modP = createGSM()
	try { return await p }
	catch (e) { _modP = null; throw e }
}

export default async function gsm(opts = {}) {
	if ((opts.sampleRate ?? 8000) !== 8000) throw RangeError(`gsm: GSM 06.10 runs at 8000 Hz, not ${opts.sampleRate}: resample first`)
	if ((opts.channels ?? 1) !== 1) throw RangeError(`gsm: GSM 06.10 is mono, not ${opts.channels} channels: one channel at a time`)
	let m = await getMod(), g = m._gsmw_create()
	if (!g) throw Error('gsm: out of memory')
	let buf = new Int16Array(N), fill = 0, cap = 0, inP = 0, outP = 0

	return { encode, flush, free }

	// round(x·2^15), clipped, as the family writes 16-bit PCM
	function q(v) { v = Math.round(v * 32768); return v > 32767 ? 32767 : v < -32768 ? -32768 : v }

	// n frames of the samples at inP into bytes
	function run(n) {
		m._gsmw_encode(g, inP, outP, n)
		return m.HEAPU8.slice(outP, outP + n * FRAME)
	}

	function room(n) {
		if (!g) throw Error('Encoder already freed')
		if (n <= cap) return
		if (cap) { m._free(inP); m._free(outP) }
		cap = n; inP = m._malloc(n * N * 2); outP = m._malloc(n * FRAME)
	}

	// encode(channels: [Float32Array] | Float32Array) → Uint8Array of the frames it filled
	function encode(ch) {
		if (!ArrayBuffer.isView(ch) && ch.length > 1) throw RangeError(`gsm: GSM 06.10 is mono, not ${ch.length} channels`)
		let x = ArrayBuffer.isView(ch) ? ch : ch[0], n = Math.floor((fill + x.length) / N), i = 0
		if (n) {
			room(n)
			let pcm = new Int16Array(m.HEAP16.buffer, inP, n * N)
			pcm.set(buf.subarray(0, fill))
			for (let j = fill; j < n * N; j++) pcm[j] = q(x[i++])
			fill = 0
		}
		while (i < x.length) buf[fill++] = q(x[i++])
		return n ? run(n) : new Uint8Array(0)
	}

	// flush() → Uint8Array: the last partial frame, zero-padded (none when the input filled its frames)
	function flush() {
		if (!fill) return new Uint8Array(0)
		room(1)
		buf.fill(0, fill); fill = 0
		new Int16Array(m.HEAP16.buffer, inP, N).set(buf)
		return run(1)
	}

	function free() {
		if (!g) return
		if (cap) { m._free(inP); m._free(outP) }
		m._gsmw_destroy(g); g = 0
	}
}
