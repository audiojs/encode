/**
 * WAV encoder — pure JS, browser + Node
 *
 * @param {Object} opts
 * @param {number} opts.sampleRate
 * @param {number} [opts.bitDepth=16] - 16 or 24 (int PCM), or 32 (float)
 * @returns {{ encode, flush, free }}
 */
export default async function wav(opts) {
	let { sampleRate, bitDepth = 16 } = opts
	if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32)
		throw Error('Unsupported bitDepth: ' + bitDepth + ' (use 16, 24, or 32)')
	let float = bitDepth === 32
	let bps = bitDepth >> 3
	let fmt = float ? 3 : 1
	let nch = 0
	let chunks = []
	let size = 0

	return { encode, flush, free }

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

		chunks.push(buf)
		size += buf.length
		return new Uint8Array(0)
	}

	// flush() → Uint8Array (complete WAV file with RIFF header)
	function flush() {
		let out = new Uint8Array(44 + size)
		let dv = new DataView(out.buffer)

		// RIFF header
		dv.setUint32(0, 0x52494646)                  // "RIFF"
		dv.setUint32(4, 36 + size, true)              // file size - 8
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
