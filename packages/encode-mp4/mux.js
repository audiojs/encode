/**
 * ISO BMFF (MP4/M4A/MOV) muxer — pure JS, no codec knowledge beyond wrapping pre-encoded
 * access units in the right boxes. moov is written before mdat so the file streams/plays
 * progressively. Single audio track only (video passthrough lives in ./remux).
 *
 * Spec references:
 *  - ISO/IEC 14496-12 (ISOBMFF) — box structure, stts/stsz/stsc/stco/co64, edts/elst
 *  - ISO/IEC 14496-14 (MP4 file format) — esds placement, brands
 *  - ISO/IEC 14496-1 §8.3 (esds descriptors) — ES_Descriptor/DecoderConfigDescriptor/SLConfigDescriptor
 *  - ISO/IEC 23003-5 (PCM in ISOBMFF) — ipcm/fpcm + pcmC
 *  - Opus in ISOBMFF — https://opus-codec.org/docs/opus_in_isobmff.html — Opus sample entry + dOps
 *  - FLAC in ISOBMFF — https://github.com/xiph/flac/blob/master/doc/isoflac.txt — fLaC sample entry + dfLa
 *  - QuickTime File Format — sound sample description v0, sowt/in24/in32/fl32/fl64/enda
 *  - iTunSMPB gapless tag — undocumented by Apple, reverse-engineered by mp4v2/AtomicParsley
 *
 * mux({ codec, sampleRate, channels, samples, config, ... }, { brand, meta, chapters }) -> Uint8Array
 */
import { Writer, concat, r32, w32, w64 } from './iso.js'
import { buildUdta, itunSmpb } from './tags.js'

const MAC_EPOCH_OFFSET = 2082844800 // seconds between 1904-01-01 and the Unix epoch
const CODECS = new Set(['aac', 'alac', 'opus', 'flac', 'mp3', 'pcm'])

const BRAND_COMPAT = {
	'M4A ': ['M4A ', 'mp42', 'isom'],
	'isom': ['isom', 'iso2', 'mp41'],
	'mp42': ['isom', 'mp42'],
	'qt  ': ['qt  '],
}

/**
 * @param {object} track - see mux.d.ts for the full field list
 * @param {object} [opts]
 * @returns {Uint8Array} complete MP4 file
 */
export function mux(track, opts = {}) {
	validateTrack(track)
	return build(track, opts, false)
}

function validateTrack(t) {
	if (!t || typeof t !== 'object') throw Error('mux: track object is required')
	if (!CODECS.has(t.codec)) throw Error("mux: unknown codec '" + t.codec + "' (expected aac/alac/opus/flac/mp3/pcm)")
	if (!t.sampleRate) throw Error('mux: track.sampleRate is required')
	if (!t.channels) throw Error('mux: track.channels is required')
	if (!Array.isArray(t.samples)) throw Error('mux: track.samples must be an array of Uint8Array (one access unit per entry)')
	if (t.codec !== 'mp3' && !t.config) throw Error("mux: track.config is required for codec '" + t.codec + "'")
	if (t.durations != null && typeof t.durations !== 'number' && t.durations.length !== t.samples.length)
		throw Error('mux: track.durations length must match track.samples length')
}

function build(track, opts, forceCo64) {
	let { samples } = track
	let n = samples.length
	let plan = planAudioTrack(track)
	let brand = opts.brand || 'M4A '
	let creation = macTime(opts.creationTime || new Date())
	let totalBytes = totalSampleBytes(samples)
	let w = new Writer(Math.max(1 << 16, totalBytes + (1 << 16)))

	buildFtyp(w, brand)

	let trak
	w.box('moov', w => {
		buildMvhd(w, creation, plan.movieDuration)
		trak = buildAudioTrak(w, plan, track, opts, { trackId: 1, movieTimescale: 1000, creation, forceCo64 })

		if (opts.meta || opts.chapters?.length) {
			let extra = {}
			if (track.codec === 'aac' && (plan.priming || plan.padding)) extra.itunSmpb = itunSmpb(plan.priming, plan.padding, plan.presentedTicks)
			w.bytes(buildUdta(opts.meta || {}, opts.chapters, extra))
		}
	})

	let mdatBodyStart = writeMdatHeader(w, totalBytes)

	// moov's byte size doesn't depend on the offset *values*, only on chunk count and word size —
	// so mdatBodyStart is already final. Detect overflow before copying sample bytes; if any
	// absolute chunk offset would exceed 32 bits and we haven't already committed to co64, redo
	// the whole build with 64-bit chunk offsets (rare: only real files approaching 4 GB hit this).
	if (!forceCo64) {
		for (let i = 0; i < plan.chunks.length; i++) {
			let abs = mdatBodyStart + plan.chunkRel[i]
			if (abs + plan.chunkLens[i] - 1 > 0xFFFFFFFF) return build(track, opts, true)
		}
	}

	for (let i = 0; i < plan.chunks.length; i++) {
		let { pos, wide } = trak.patches[i]
		let abs = mdatBodyStart + plan.chunkRel[i]
		if (wide) w64(w.buf, pos, abs); else w32(w.buf, pos, abs)
	}

	for (let i = 0; i < n; i++) w.bytes(samples[i])

	return w.finish()
}

/**
 * Plan an audio track's sample tables without writing any bytes: durations, chunking,
 * per-chunk byte lengths/relative offsets/start times, and the movie-timescale duration a
 * caller wants (mux() uses timescale 1000; remux() reuses the source file's mvhd timescale).
 * Exported so remux.js can plan the replacement audio track the same way mux() does.
 */
export function planAudioTrack(track, movieTimescale = 1000) {
	let { samples, codec } = track
	let n = samples.length
	let dur = resolveDurations(track)
	let timescale = track.timescale ?? (codec === 'opus' ? 48000 : track.sampleRate)

	let trackDurationTicks = 0
	if (dur.isConst) trackDurationTicks = dur.val * n
	else for (let i = 0; i < n; i++) trackDurationTicks += dur.get(i)

	let priming = track.priming ?? (codec === 'opus' ? (track.config?.preSkip || 0) : 0)
	let padding = track.padding || 0
	let presentedTicks = Math.max(0, trackDurationTicks - priming - padding)
	let movieDuration = Math.round(presentedTicks / timescale * movieTimescale)

	let chunks = planChunks(n, dur, timescale)
	let { rel: chunkRel, lens: chunkLens } = chunkRelOffsets(chunks, samples)
	let chunkTimes = chunkStartTimes(chunks, dur, timescale)

	return { dur, timescale, movieTimescale, trackDurationTicks, priming, padding, presentedTicks, movieDuration, chunks, chunkRel, chunkLens, chunkTimes }
}

/**
 * Write a complete 'trak' box for an audio track from a planAudioTrack() plan. stco/co64 chunk
 * offset entries are written as zero placeholders; returns `{ patches }` (positions + word width
 * in the Writer's buffer) so the caller backpatches real absolute offsets once mdat's start is known.
 * Exported so remux.js can build the replacement audio trak with the exact same box layout mux() uses.
 */
export function buildAudioTrak(w, plan, track, opts, { trackId, movieTimescale, creation, forceCo64 }) {
	let { samples } = track
	let n = samples.length
	let patches
	w.box('trak', w => {
		buildTkhd(w, creation, plan.movieDuration, trackId)
		if (plan.priming || plan.padding) buildEdts(w, plan.movieDuration, plan.priming)
		w.box('mdia', w => {
			buildMdhd(w, creation, plan.timescale, plan.trackDurationTicks)
			buildHdlr(w)
			w.box('minf', w => {
				w.fullBox('smhd', 0, 0, w => w.u16(0).u16(0))
				w.box('dinf', w => buildDref(w))
				w.box('stbl', w => {
					buildStsd(w, track, opts)
					buildStts(w, sttsRuns(n, plan.dur))
					buildStsz(w, samples, n)
					buildStsc(w, stscRuns(plan.chunks))
					patches = writeStco(w, plan.chunks.length, forceCo64)
				})
			})
		})
	})
	return { patches }
}

// ===== duration resolution =====

function constDur(v) { return { isConst: true, val: v, get: () => v } }

function resolveDurations(track) {
	let { durations, codec, samples, config, channels } = track
	if (durations != null) {
		if (typeof durations === 'number') return constDur(durations)
		return { isConst: false, get: i => durations[i] }
	}
	switch (codec) {
		case 'aac': return constDur(1024)
		case 'alac': return constDur(r32(config, 0)) // frameLength, ALACSpecificConfig byte 0-3
		case 'opus': return { isConst: false, get: i => opusPacketDuration(samples[i]) }
		case 'flac': return { isConst: false, get: i => flacBlockSize(samples[i]) }
		case 'mp3': return { isConst: false, get: i => mp3FrameDuration(samples[i]) }
		case 'pcm': {
			let bytesPerFrame = (config.bits >> 3) * channels
			return { isConst: false, get: i => Math.floor(samples[i].length / bytesPerFrame) }
		}
	}
}

// RFC 6716 §3.1 Table 2 — frame size in ms per TOC config number (0-31)
const OPUS_FRAME_MS = [10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20]

function opusPacketDuration(packet) {
	if (!packet?.length) throw Error('mux: empty Opus packet')
	let toc = packet[0], config = toc >> 3, code = toc & 0x3
	let frameCount = code === 0 ? 1 : code === 1 || code === 2 ? 2 : (() => {
		if (packet.length < 2) throw Error('mux: malformed Opus packet (code 3 with no frame-count byte)')
		return packet[1] & 0x3F
	})()
	return Math.round(OPUS_FRAME_MS[config] * 48 * frameCount) // ms * 48 samples/ms @ 48 kHz
}

// UTF-8-style leading-byte length used by FLAC's coded frame/sample number (extended to 7 bytes)
function utf8CodedLen(b0) {
	if (!(b0 & 0x80)) return 1
	let n = 0
	for (let m = 0x80; m && (b0 & m); m >>= 1) n++
	return n
}

function flacBlockSize(frame) {
	if (frame.length < 5 || frame[0] !== 0xFF || (frame[1] & 0xFE) !== 0xF8) throw Error('mux: not a FLAC frame (bad sync code)')
	let code = frame[2] >> 4
	if (code === 0) throw Error('mux: FLAC frame has reserved block-size code')
	if (code === 1) return 192
	if (code >= 2 && code <= 5) return 576 << (code - 2)
	if (code >= 8) return 256 << (code - 8)
	let pos = 4 + utf8CodedLen(frame[4]) // code 6 or 7: extended size follows the coded frame number
	return code === 6 ? frame[pos] + 1 : ((frame[pos] << 8) | frame[pos + 1]) + 1
}

function mp3FrameDuration(frame) {
	if (frame.length < 4 || frame[0] !== 0xFF || (frame[1] & 0xE0) !== 0xE0) throw Error('mux: not an MP3 frame (bad sync code)')
	let mpegVersion = (frame[1] >> 3) & 0x3 // 00=MPEG2.5, 10=MPEG2, 11=MPEG1
	return mpegVersion === 3 ? 1152 : 576
}

// ===== sample-table planning =====

function sttsRuns(n, dur) {
	if (dur.isConst) return n ? [{ count: n, delta: dur.val }] : []
	let runs = [], i = 0
	while (i < n) {
		let d = dur.get(i), c = 1
		while (i + c < n && dur.get(i + c) === d) c++
		runs.push({ count: c, delta: d })
		i += c
	}
	return runs
}

// ~1s per chunk or 128 AUs, whichever comes first
function planChunks(n, dur, timescale) {
	let chunks = [], i = 0
	while (i < n) {
		let count = 0, acc = 0
		while (i < n) {
			acc += dur.isConst ? dur.val : dur.get(i)
			count++; i++
			if (count >= 128 || acc >= timescale) break
		}
		chunks.push(count)
	}
	return chunks
}

function stscRuns(chunks) {
	let runs = [], i = 0
	while (i < chunks.length) {
		let spc = chunks[i], j = i + 1
		while (j < chunks.length && chunks[j] === spc) j++
		runs.push({ firstChunk: i + 1, samplesPerChunk: spc })
		i = j
	}
	return runs
}

function chunkRelOffsets(chunks, samples) {
	let rel = new Array(chunks.length), lens = new Array(chunks.length)
	let off = 0, si = 0
	for (let c = 0; c < chunks.length; c++) {
		rel[c] = off
		let len = 0
		for (let k = 0; k < chunks[c]; k++) { len += samples[si].length; si++ }
		lens[c] = len
		off += len
	}
	return { rel, lens }
}

// start time of each chunk, in seconds — used by remux.js to interleave audio chunks with video chunks
function chunkStartTimes(chunks, dur, timescale) {
	let times = new Array(chunks.length)
	let acc = 0, si = 0
	for (let c = 0; c < chunks.length; c++) {
		times[c] = acc / timescale
		for (let k = 0; k < chunks[c]; k++) { acc += dur.isConst ? dur.val : dur.get(si); si++ }
	}
	return times
}

export function totalSampleBytes(samples) {
	let t = 0
	for (let s of samples) t += s.length
	return t
}

// ===== box builders =====

export function macTime(date) { return Math.floor(date.getTime() / 1000) + MAC_EPOCH_OFFSET }

function unityMatrix(w) { w.u32(0x10000).u32(0).u32(0).u32(0).u32(0x10000).u32(0).u32(0).u32(0).u32(0x40000000) }

export function buildFtyp(w, brand) {
	let compat = BRAND_COMPAT[brand] || [brand]
	w.box('ftyp', w => {
		w.ascii(brand).u32(0)
		for (let c of compat) w.ascii(c)
	})
}

function buildMvhd(w, creation, duration, nextTrackId = 2) {
	w.fullBox('mvhd', 0, 0, w => {
		w.u32(creation).u32(creation)
		w.u32(1000).u32(duration)
		w.fixed1616(1).fixed88(1)
		w.u16(0).u32(0).u32(0)
		unityMatrix(w)
		for (let i = 0; i < 6; i++) w.u32(0) // pre_defined
		w.u32(nextTrackId)
	})
}

/** Exported so remux.js can rebuild mvhd against the source file's own timescale/next_track_ID. */
export function writeMvhd(w, creation, modification, timescale, duration, nextTrackId) {
	w.fullBox('mvhd', 0, 0, w => {
		w.u32(creation).u32(modification)
		w.u32(timescale).u32(duration)
		w.fixed1616(1).fixed88(1)
		w.u16(0).u32(0).u32(0)
		unityMatrix(w)
		for (let i = 0; i < 6; i++) w.u32(0) // pre_defined
		w.u32(nextTrackId)
	})
}

function buildTkhd(w, creation, duration, trackId = 1) {
	w.fullBox('tkhd', 0, 0x000007, w => { // flags: enabled | in-movie | in-preview
		w.u32(creation).u32(creation)
		w.u32(trackId).u32(0) // track_ID, reserved
		w.u32(duration)
		w.u32(0).u32(0) // reserved[2]
		w.u16(0).u16(0) // layer, alternate_group
		w.fixed88(1)    // volume — full, this is an audio track
		w.u16(0)
		unityMatrix(w)
		w.fixed1616(0).fixed1616(0) // width, height — none for audio
	})
}

function buildEdts(w, segDuration, mediaTime) {
	w.box('edts', w => {
		w.fullBox('elst', 0, 0, w => {
			w.u32(1)
			w.u32(segDuration).u32(mediaTime)
			w.u16(1).u16(0) // media_rate = 1.0
		})
	})
}

function buildMdhd(w, creation, timescale, duration) {
	w.fullBox('mdhd', 0, 0, w => {
		w.u32(creation).u32(creation)
		w.u32(timescale).u32(duration)
		w.u16(0x55C4) // language = 'und'
		w.u16(0)
	})
}

function buildHdlr(w) {
	w.fullBox('hdlr', 0, 0, w => {
		w.u32(0).ascii('soun')
		w.u32(0).u32(0).u32(0)
		w.ascii('SoundHandler').u8(0)
	})
}

function buildDref(w) {
	w.fullBox('dref', 0, 0, w => {
		w.u32(1)
		w.fullBox('url ', 0, 1, () => {}) // flags=1 (self-contained): empty URL means "same file"
	})
}

function buildStts(w, runs) {
	w.fullBox('stts', 0, 0, w => {
		w.u32(runs.length)
		for (let r of runs) w.u32(r.count).u32(r.delta)
	})
}

function buildStsz(w, samples, n) {
	let constSize = n ? samples[0].length : 0
	for (let i = 1; i < n; i++) if (samples[i].length !== constSize) { constSize = 0; break }
	w.fullBox('stsz', 0, 0, w => {
		w.u32(constSize).u32(n)
		if (!constSize) for (let i = 0; i < n; i++) w.u32(samples[i].length)
	})
}

function buildStsc(w, runs) {
	w.fullBox('stsc', 0, 0, w => {
		w.u32(runs.length)
		for (let r of runs) w.u32(r.firstChunk).u32(r.samplesPerChunk).u32(1)
	})
}

function writeStco(w, count, wide) {
	let patches = new Array(count)
	w.fullBox(wide ? 'co64' : 'stco', 0, 0, w => {
		w.u32(count)
		for (let i = 0; i < count; i++) {
			patches[i] = { pos: w.len, wide }
			if (wide) w.u64(0); else w.u32(0)
		}
	})
	return patches
}

export function writeMdatHeader(w, totalBytes) {
	if (totalBytes + 8 > 0xFFFFFFFF) w.u32(1).ascii('mdat').u64(totalBytes + 16)
	else w.u32(totalBytes + 8).ascii('mdat')
	return w.len
}

// ===== sample entry + codec config boxes =====

function buildStsd(w, track, opts) {
	w.fullBox('stsd', 0, 0, w => {
		w.u32(1)
		buildSampleEntry(w, track, opts)
	})
}

function audioSampleEntry(w, type, channels, bits, sampleRate, children) {
	w.box(type, w => {
		w.zero(6).u16(1)     // reserved, data_reference_index
		w.u16(0).u16(0)      // version, revision_level
		w.u32(0)             // vendor
		w.u16(channels).u16(bits)
		w.u16(0).u16(0)      // pre_defined, reserved
		w.fixed1616(sampleRate)
		children(w)
	})
}

function writeBtrt(w, bitrate) { w.u32(0).u32(bitrate).u32(bitrate) } // bufferSizeDB, maxBitrate, avgBitrate

function buildSampleEntry(w, track, opts) {
	let { codec, channels, sampleRate, config, bitrate } = track
	if (codec === 'aac') {
		audioSampleEntry(w, 'mp4a', channels, 16, sampleRate, w => {
			w.fullBox('esds', 0, 0, w => w.bytes(buildEsds(config, bitrate)))
			if (bitrate) w.box('btrt', w => writeBtrt(w, bitrate))
		})
	} else if (codec === 'alac') {
		audioSampleEntry(w, 'alac', channels, config[5] || 16, sampleRate, w => {
			w.fullBox('alac', 0, 0, w => w.bytes(config))
		})
	} else if (codec === 'opus') {
		audioSampleEntry(w, 'Opus', channels, 16, 48000, w => {
			w.box('dOps', w => w.bytes(buildDOps(config, channels)))
		})
	} else if (codec === 'flac') {
		audioSampleEntry(w, 'fLaC', channels, 16, sampleRate, w => {
			w.fullBox('dfLa', 0, 0, w => w.bytes(buildDfLa(config)))
			if (bitrate) w.box('btrt', w => writeBtrt(w, bitrate))
		})
	} else if (codec === 'mp3') {
		audioSampleEntry(w, '.mp3', channels, 16, sampleRate, () => {})
	} else if (codec === 'pcm') {
		let { bits, float, be } = config
		if (opts.brand === 'qt  ') {
			let type = bits === 16 ? 'sowt' : float ? (bits === 64 ? 'fl64' : 'fl32') : (bits === 32 ? 'in32' : 'in24')
			audioSampleEntry(w, type, channels, bits, sampleRate, w => {
				if (type !== 'sowt' && !be) w.box('enda', w => w.u16(1)) // absent enda defaults to big-endian
			})
		} else {
			audioSampleEntry(w, float ? 'fpcm' : 'ipcm', channels, bits, sampleRate, w => {
				w.fullBox('pcmC', 0, 0, w => w.u8(be ? 0 : 1).u8(bits)) // FormatFlags bit0: 0=BE, 1=LE
			})
		}
	}
}

// --- esds (ISO/IEC 14496-1 §8.3 descriptors) ---

function descLenBytes(n) {
	if (n < 0x80) return [n]
	let out = []
	do { out.unshift(n & 0x7f); n >>= 7 } while (n > 0)
	return out.map((b, i) => i < out.length - 1 ? b | 0x80 : b)
}

function descriptor(tag, body) {
	let len = descLenBytes(body.length)
	let w = new Writer(body.length + len.length + 1)
	w.u8(tag)
	for (let b of len) w.u8(b)
	w.bytes(body)
	return w.finish()
}

function buildEsds(asc, bitrate) {
	let dsi = descriptor(0x05, asc) // DecoderSpecificInfo = raw AudioSpecificConfig
	let dcd = new Writer(16)
	dcd.u8(0x40)                 // objectTypeIndication: MPEG-4 Audio
	dcd.u8(0x15)                 // streamType(5, audio)<<2 | upStream(0)<<1 | reserved(1)
	dcd.u24(6144)                // bufferSizeDB (informational)
	dcd.u32(bitrate || 0).u32(bitrate || 0) // maxBitrate, avgBitrate
	let dcdDesc = descriptor(0x04, concat([dcd.finish(), dsi]))
	let slc = descriptor(0x06, new Uint8Array([0x02])) // SLConfigDescriptor, predefined=2 (MP4 file)
	let es = new Writer(4)
	es.u16(0).u8(0) // ES_ID, flags (no dependsOn/OCR/URL)
	return descriptor(0x03, concat([es.finish(), dcdDesc, slc]))
}

// --- dOps (Opus in ISOBMFF) ---

function buildDOps(config, channels) {
	let w = new Writer(32)
	w.u8(0).u8(channels)                 // Version, OutputChannelCount
	w.u16(config.preSkip || 0)
	w.u32(48000)                         // InputSampleRate (informational — decode is always 48kHz)
	w.i16(config.outputGain || 0)
	let family = config.channelMappingFamily ?? (config.channelMappingTable ? 1 : 0)
	w.u8(family)
	if (family !== 0) {
		w.u8(config.streamCount ?? channels)
		w.u8(config.coupledStreamCount ?? 0)
		w.bytes(Uint8Array.from(config.channelMappingTable || []))
	}
	return w.finish()
}

// --- dfLa (FLAC in ISOBMFF) ---

function buildDfLa(config) {
	if (config.length === 34) {
		let w = new Writer(38)
		w.u8(0x80).u24(34).bytes(config) // last-metadata-block=1, BLOCK_TYPE=0 (STREAMINFO)
		return w.finish()
	}
	// caller passed one or more raw METADATA_BLOCK structures (own headers); force last-flag on the final one
	let blocks = config.slice(), off = 0, lastStart = 0
	while (off < blocks.length) {
		lastStart = off
		let len = (blocks[off + 1] << 16) | (blocks[off + 2] << 8) | blocks[off + 3]
		off += 4 + len
	}
	blocks[lastStart] |= 0x80
	return blocks
}
