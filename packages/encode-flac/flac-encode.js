// requires: libflacjs
/**
 * FLAC encoder — browser + Node, uses libflacjs (libFLAC compiled to JS/WASM)
 *
 * @param {Object} opts
 * @param {number} opts.sampleRate - required
 * @param {number} [opts.channels] - 1 or 2 (default from input)
 * @param {number} [opts.bitDepth=16] - 16 or 24
 * @param {number} [opts.compression=5] - compression level 0-8
 * @param {boolean} [opts.stream] - with `meta`: metadata blocks go into the streamed header
 * @param {number} [opts.frames] - the exact length, when known upfront: STREAMINFO says it from the start
 * @returns {{ encode, flush, free, head }}
 *
 * encode(channels: Float32Array[]) → Uint8Array
 * flush() → Uint8Array
 * free() → void
 * head() → Uint8Array: after flush, the first 42 bytes with the final STREAMINFO (total samples,
 *   MD5, frame sizes), which libFLAC can only know at the end: write it over the start
 */
export default async function flac(opts) {
	let { sampleRate, channels: nch, bitDepth = 16, compression = 5, stream, meta } = opts
	let max = bitDepth === 24 ? 8388607 : 32767
	let min = -max - 1
	let buf = [], enc, Flac, inited = false
	let writeMeta = stream && meta ? (await import('./meta.js')).writeMeta : null
	let prefix = new Uint8Array(0), first = null, info = null, total = 0, exact = null

	// load libflac — works as CJS in ESM context
	let mod = await import('libflacjs/dist/libflac.js')
	Flac = mod.default || mod

	// wait for ready if async variant
	if (!Flac.isReady()) await new Promise(r => Flac.on('ready', r))

	return { encode: feed, flush, free, head }

	function init(numCh) {
		nch = nch || numCh
		enc = Flac.create_libflac_encoder(sampleRate, nch, bitDepth, compression, opts.frames || 0, false, 0)
		if (!enc) throw Error('FLAC encoder creation failed')
		let status = Flac.init_encoder_stream(enc, write_cb, si => { info = si })
		if (status !== 0) throw Error('FLAC encoder init failed: ' + status)
		inited = true
	}

	function write_cb(data) { buf.push(new Uint8Array(data)) }

	function feed(channels) {
		if (!inited) init(channels.length)
		let len = channels[0].length
		let interleaved = new Int32Array(len * nch)
		for (let i = 0; i < len; i++) {
			for (let c = 0; c < nch; c++) {
				let s = Math.round(channels[c][i] * max)
				interleaved[i * nch + c] = s < min ? min : s > max ? max : s
			}
		}
		if (!Flac.FLAC__stream_encoder_process_interleaved(enc, interleaved, len))
			throw Error('FLAC encoding failed')
		total += len
		return drain()
	}

	function flush() {
		if (!inited) return new Uint8Array(0)
		Flac.FLAC__stream_encoder_finish(enc)
		let out = drain()
		Flac.FLAC__stream_encoder_delete(enc)
		enc = null; inited = false
		if (first && info) exact = streaminfo(first)
		return out
	}

	function head() { return exact }

	// STREAMINFO (RFC 9639 §8.2) with libFLAC's final values; the sample count is ours: libflacjs
	// reads the 64-bit field through a 32-bit path
	function streaminfo(h) {
		let b = h.slice(), dv = new DataView(b.buffer, 8)
		dv.setUint16(0, info.min_blocksize); dv.setUint16(2, info.max_blocksize)
		dv.setUint16(4, info.min_framesize >>> 8); dv.setUint8(6, info.min_framesize & 0xff)
		dv.setUint16(7, info.max_framesize >>> 8); dv.setUint8(9, info.max_framesize & 0xff)
		dv.setUint8(13, (dv.getUint8(13) & 0xf0) | Math.floor(total / 0x100000000) & 0x0f)
		dv.setUint32(14, total >>> 0)
		for (let i = 0; i < 16; i++) dv.setUint8(18 + i, parseInt(info.md5sum.slice(2 * i, 2 * i + 2), 16) || 0)
		return b
	}

	function free() {
		if (enc) {
			try { Flac.FLAC__stream_encoder_finish(enc) } catch (_) {}
			Flac.FLAC__stream_encoder_delete(enc)
		}
		enc = null; buf = null; inited = false
	}

	function drain() {
		if (!buf.length) return new Uint8Array(0)
		let n = 0
		for (let i = 0; i < buf.length; i++) n += buf[i].length
		let out = new Uint8Array(n), off = 0
		for (let i = 0; i < buf.length; i++) { out.set(buf[i], off); off += buf[i].length }
		buf.length = 0
		if (first) return out
		// the metadata blocks come first: hold them until the last one, splice `meta` in (streamed),
		// and keep the leading 42 bytes (fLaC + STREAMINFO) for head()
		let all = new Uint8Array(prefix.length + out.length)
		all.set(prefix); all.set(out, prefix.length)
		let end = metaEnd(all)
		if (end < 0) { prefix = all; return new Uint8Array(0) }
		prefix = null
		let hdr = writeMeta ? writeMeta(all.subarray(0, end), { meta }) : all.subarray(0, end)
		first = hdr.slice(0, 42)
		if (hdr.length === end) return all
		let res = new Uint8Array(hdr.length + all.length - end)
		res.set(hdr); res.set(all.subarray(end), hdr.length)
		return res
	}
}

/** Byte offset after the last metadata block, or -1 while incomplete. */
function metaEnd(b) {
	if (b.length < 4) return -1
	for (let o = 4; o + 4 <= b.length;) {
		let last = b[o] & 0x80, size = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]
		o += 4 + size
		if (o > b.length) return -1
		if (last) return o
	}
	return -1
}
