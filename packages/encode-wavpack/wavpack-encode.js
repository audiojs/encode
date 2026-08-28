/**
 * WavPack encoder — libwavpack compiled to WASM (single-file module, host-neutral), encode-only
 * build (no file-input/decode side, no DSD).
 *
 * @param {Object} opts
 * @param {number} opts.sampleRate - required
 * @param {number} [opts.channels=1]
 * @param {16|24|32|'float'} [opts.bitDepth=16]
 * @param {false|number} [opts.hybrid=false] - bitrate-per-sample (< 24, e.g. 4 = ~4 bits/sample)
 *   or kbps (>= 24); enables lossy hybrid mode (CONFIG_HYBRID_FLAG). No .wvc correction file.
 * @param {number} [opts.extraProcessing=0] - 0-6, CONFIG_EXTRA_MODE level (xmode)
 * @param {boolean} [opts.highQuality] - CONFIG_HIGH_FLAG
 * @param {boolean} [opts.veryHigh] - CONFIG_VERY_HIGH_FLAG (implies highQuality)
 * @param {boolean} [opts.fast] - CONFIG_FAST_FLAG
 * @param {number} [opts.blockSamples] - fixed WavPack block size, 16-131072 samples (library default if omitted)
 * @param {object} [opts.meta] - APEv2 tags: title, artist, album, albumartist, composer, genre,
 *   year, track, disc, comment, copyright, isrc, publisher, software, lyrics, pictures[]
 * @returns {{ encode, flush, free }}
 *
 * encode(channels: Float32Array[]) -> Uint8Array (any WavPack blocks completed by this chunk)
 * flush() -> Uint8Array (final partial block + APEv2 tag, if any; frees the encoder)
 * free() -> void
 */
import createWavpackEncoder from './src/wavpack.wasm.js'

const BIT_DEPTHS = new Set([8, 16, 24, 32])
const APE_MAP = {
	title: 'Title', artist: 'Artist', album: 'Album', albumartist: 'Album Artist',
	composer: 'Composer', genre: 'Genre', year: 'Year', track: 'Track', disc: 'Disc',
	comment: 'Comment', copyright: 'Copyright', isrc: 'ISRC', publisher: 'Publisher',
	software: 'Encoder', lyrics: 'Lyrics',
}
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }

let modP
function getMod() {
	if (modP) return modP
	let p = createWavpackEncoder()
	modP = p
	return p.catch(e => { modP = null; throw e })
}

export default async function wavpack(opts = {}) {
	let sampleRate = opts.sampleRate
	if (!sampleRate) throw Error('sampleRate is required')
	let channels = opts.channels || 1
	let isFloat = opts.bitDepth === 'float'
	let bitDepth = isFloat ? 32 : (opts.bitDepth || 16)
	if (!isFloat && !BIT_DEPTHS.has(bitDepth)) throw Error('bitDepth must be 16, 24, 32 or \'float\'')
	let xmode = opts.extraProcessing || 0
	if (xmode < 0 || xmode > 6) throw Error('extraProcessing must be 0-6')
	let quality = opts.veryHigh ? 2 : opts.highQuality ? 1 : 0
	let hybrid = opts.hybrid ? 1 : 0
	let bitrate = opts.hybrid || 0

	let m = await getMod()
	let h = m._we_create(sampleRate, channels, bitDepth, isFloat ? 1 : 0, hybrid, bitrate, xmode, quality, opts.fast ? 1 : 0, opts.blockSamples || 0)
	if (!h || !m._we_ok(h)) throw Error(readError(m, h))
	if (opts.meta) writeMeta(m, h, opts.meta)

	let div = isFloat ? 0 : 2 ** (bitDepth - 1), max = div - 1
	let freed = false

	return { encode: encodeChunk, flush, free }

	function encodeChunk(chData) {
		if (freed) throw Error('Encoder already freed')
		let n = chData[0] ? chData[0].length : 0
		if (!n) return EMPTY
		let dst = m._we_input(h, n)
		if (!dst) throw Error(readError(m, h))
		if (isFloat) {
			let f32 = new Float32Array(m.HEAPU8.buffer, dst, n * channels)
			for (let i = 0, k = 0; i < n; i++) for (let c = 0; c < channels; c++) f32[k++] = chData[c][i]
		} else {
			let i32 = m.HEAP32, k = dst >> 2
			for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) {
				let v = chData[c][i]
				let s = v < 0 ? v * div : v * max
				i32[k++] = s < -div ? -div : s > max ? max : Math.round(s)
			}
		}
		if (!m._we_pack(h, n)) throw Error(readError(m, h))
		return drain()
	}

	function flush() {
		if (freed) throw Error('Encoder already freed')
		if (!m._we_flush(h)) throw Error(readError(m, h))
		let out = drain()
		free()
		return out
	}

	function free() {
		if (freed) return
		freed = true
		m._we_destroy(h)
		h = 0
	}

	function drain() {
		let len = m._we_output_len(h)
		if (!len) return EMPTY
		let ptr = m._we_output_ptr(h)
		let out = m.HEAPU8.slice(ptr, ptr + len)
		m._we_output_reset(h)
		return out
	}
}

const EMPTY = new Uint8Array(0)
const TE = new TextEncoder()

function writeMeta(m, h, meta) {
	for (let k in APE_MAP) {
		let v = meta[k]
		if (v == null || v === '') continue
		let bytes = TE.encode(String(v))
		let ok = withCStr(m, APE_MAP[k], item => withBytes(m, bytes, val => m._we_tag_text(h, item, val, bytes.length)))
		if (!ok) throw Error(readError(m, h))
	}
	if (meta.pictures) for (let p of meta.pictures) {
		let name = TE.encode((p.description || 'cover') + '.' + (MIME_EXT[p.mime] || 'bin') + '\0')
		let value = new Uint8Array(name.length + p.data.length)
		value.set(name); value.set(p.data, name.length)
		let ok = withCStr(m, 'Cover Art (Front)', item => withBytes(m, value, val => m._we_tag_binary(h, item, val, value.length)))
		if (!ok) throw Error(readError(m, h))
	}
}

// Copy `bytes` to a scratch WASM allocation, run `fn(ptr)`, free it, return fn's result.
function withBytes(m, bytes, fn) {
	let ptr = m._malloc(bytes.length || 1)
	m.HEAPU8.set(bytes, ptr)
	try { return fn(ptr) } finally { m._free(ptr) }
}
// Same, but NUL-terminated (for char* item-name arguments).
function withCStr(m, str, fn) {
	let bytes = TE.encode(str)
	let ptr = m._malloc(bytes.length + 1)
	m.HEAPU8.set(bytes, ptr)
	m.HEAPU8[ptr + bytes.length] = 0
	try { return fn(ptr) } finally { m._free(ptr) }
}

function readError(m, h) {
	if (!h) return 'WavPack: encoder allocation failed'
	let ptr = m._we_error(h)
	let bytes = m.HEAPU8.subarray(ptr, ptr + 128)
	let nul = bytes.indexOf(0)
	return new TextDecoder().decode(bytes.subarray(0, nul < 0 ? 128 : nul)) || 'WavPack: encoder error'
}
