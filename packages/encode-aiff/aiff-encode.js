/**
 * AIFF encoder — browser + Node, zero dependencies
 * @param {Object} opts
 * @param {number} opts.sampleRate
 * @param {number} [opts.bitDepth=16] - 16 or 24
 * @returns {{ encode, flush, free }}
 */
export default async function aiff(opts) {
	let rate = opts.sampleRate, depth = opts.bitDepth || 16
	if (depth !== 16 && depth !== 24)
		throw Error('Unsupported bitDepth: ' + depth + ' (use 16 or 24)')
	let bytesPerSample = depth >> 3
	let chunks = [], totalBytes = 0, numFrames = 0, nCh = 0

	return { encode, flush, free }

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
		chunks.push(buf)
		return new Uint8Array(0)
	}

	function flush() {
		if (!nCh) nCh = 1

		let dataSize = totalBytes
		let ssndSize = dataSize + 8
		let formSize = 4 + 26 + 8 + ssndSize // AIFF(4) + COMM(8+18) + SSND(8+ssndSize)
		let hdrLen = 12 + 26 + 16 // FORM(12) + COMM(8+18) + SSND hdr(8+4+4)

		let hdr = new Uint8Array(hdrLen)
		let dv = new DataView(hdr.buffer)
		let p = 0

		// FORM
		str('FORM'); dv.setUint32(p, formSize, false); p += 4; str('AIFF')

		// COMM
		str('COMM'); dv.setUint32(p, 18, false); p += 4
		dv.setInt16(p, nCh, false); p += 2
		dv.setUint32(p, numFrames, false); p += 4
		dv.setInt16(p, depth, false); p += 2
		writeF80(dv, p, rate); p += 10

		// SSND
		str('SSND'); dv.setUint32(p, ssndSize, false); p += 4
		dv.setUint32(p, 0, false); p += 4
		dv.setUint32(p, 0, false); p += 4

		let file = new Uint8Array(hdr.length + dataSize)
		file.set(hdr)
		let off = hdr.length
		for (let c of chunks) { file.set(c, off); off += c.length }
		return file

		function str(s) { for (let i = 0; i < 4; i++) hdr[p++] = s.charCodeAt(i) }
	}

	function free() { chunks = null; totalBytes = 0; numFrames = 0; nCh = 0 }
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
