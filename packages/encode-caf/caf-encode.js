/**
 * CAF (Core Audio Format) LPCM encoder — browser + Node, zero dependencies
 * @param {Object} opts
 * @param {number} opts.sampleRate
 * @param {number} [opts.bitDepth=16] - 16 (int) or 32 (float)
 * @returns {{ encode, flush, free }}
 */
export default async function caf(opts) {
	let rate = opts.sampleRate, depth = opts.bitDepth || 16
	if (depth !== 16 && depth !== 32)
		throw Error('Unsupported bitDepth: ' + depth + ' (use 16 or 32)')
	let isFloat = depth === 32
	let bytesPerSample = depth >> 3
	let chunks = [], totalBytes = 0, nCh = 0

	return { encode, flush, free }

	function encode(channels) {
		let cn = channels.length, len = channels[0].length
		if (!nCh) nCh = cn
		let buf = new Uint8Array(len * cn * bytesPerSample)
		let dv = new DataView(buf.buffer)
		let pos = 0

		if (isFloat) {
			for (let i = 0; i < len; i++) {
				for (let c = 0; c < cn; c++) {
					let s = channels[c][i]
					s = s < -1 ? -1 : s > 1 ? 1 : s
					dv.setFloat32(pos, s, false)
					pos += 4
				}
			}
		} else {
			for (let i = 0; i < len; i++) {
				for (let c = 0; c < cn; c++) {
					let s = channels[c][i]
					s = s < -1 ? -1 : s > 1 ? 1 : s
					dv.setInt16(pos, Math.round(s * 0x7FFF), false)
					pos += 2
				}
			}
		}

		totalBytes += buf.length
		chunks.push(buf)
		return new Uint8Array(0)
	}

	function flush() {
		if (!nCh) nCh = 1

		// CAF file header (8) + desc chunk (12+32) + data chunk header (12+4)
		let hdrLen = 8 + 44 + 16
		let hdr = new Uint8Array(hdrLen)
		let dv = new DataView(hdr.buffer)
		let p = 0

		// File header: 'caff' + version=1 + flags=0
		str4(hdr, p, 'caff'); p += 4
		dv.setUint16(p, 1, false); p += 2   // mFileVersion
		dv.setUint16(p, 0, false); p += 2   // mFileFlags

		// 'desc' chunk: type(4) + size Int64(8) + body(32)
		str4(hdr, p, 'desc'); p += 4
		dv.setUint32(p, 0, false); p += 4   // size high 32 bits
		dv.setUint32(p, 32, false); p += 4  // size low 32 bits = 32
		dv.setFloat64(p, rate, false); p += 8            // mSampleRate
		str4(hdr, p, 'lpcm'); p += 4                     // mFormatID
		// mFormatFlags: float=1 (float, big-endian), int=0
		dv.setUint32(p, isFloat ? 1 : 0, false); p += 4
		dv.setUint32(p, nCh * bytesPerSample, false); p += 4  // mBytesPerPacket
		dv.setUint32(p, 1, false); p += 4                     // mFramesPerPacket
		dv.setUint32(p, nCh, false); p += 4                   // mChannelsPerFrame
		dv.setUint32(p, depth, false); p += 4                 // mBitsPerChannel

		// 'data' chunk: type(4) + size Int64(8) + mEditCount(4) + pcm
		let pcmBytes = totalBytes
		let dataBodySize = 4 + pcmBytes  // mEditCount(4) + pcm
		str4(hdr, p, 'data'); p += 4
		dv.setUint32(p, 0, false); p += 4                      // size high 32 bits
		dv.setUint32(p, dataBodySize, false); p += 4           // size low 32 bits
		dv.setUint32(p, 0, false); p += 4                      // mEditCount = 0

		let file = new Uint8Array(hdr.length + pcmBytes)
		file.set(hdr)
		let off = hdr.length
		for (let c of chunks) { file.set(c, off); off += c.length }
		return file
	}

	function free() { chunks = null; totalBytes = 0; nCh = 0 }
}

function str4(buf, off, s) {
	for (let i = 0; i < 4; i++) buf[off + i] = s.charCodeAt(i)
}
