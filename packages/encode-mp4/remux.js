/**
 * MP4/MOV/M4V/3GP remuxer — replace or strip the audio track, video (and any other non-audio
 * track: subtitles, timecode) passes through untouched. No re-encode. A single fresh mdat is
 * built with video and audio chunks interleaved by presentation time so the file still plays
 * progressively.
 *
 * remux(src, audio, opts) -> Uint8Array
 *   src:   Uint8Array — the source MP4/MOV
 *   audio: null (strip audio) | a mux()-shaped track object (replace audio) |
 *          Uint8Array (an audio-only MP4 produced by mux() — its track is extracted and reused)
 *
 * Spec: ISO/IEC 14496-12 (ISOBMFF box structure, 64-bit sizes, 'uuid', multi-mdat).
 */
import {
	Writer, parseBoxes, find, findPath, r16, r32, typ4, w32, w64, copyBoxTree,
	parseStts, parseStsz, parseStsc, parseChunkOffsets, spcAt, readSampleEntry,
} from './iso.js'
import { planAudioTrack, buildAudioTrak, buildFtyp, macTime, writeMdatHeader, writeMvhd } from './mux.js'
import { buildUdta } from './tags.js'

const MP3_OTI = new Set([0x69, 0x6B]), AAC_OTI = new Set([0x40, 0x66, 0x67, 0x68])

export function remux(src, audio, opts = {}) {
	let bytes = src instanceof Uint8Array ? src : new Uint8Array(src.buffer || src)
	let top = parseBoxes(bytes, 0, bytes.length)
	if (find(top, 'moof')) throw Error('remux: fragmented MP4 is not supported')

	let moovNode = find(top, 'moov')
	if (!moovNode) throw Error('remux: no moov box found (not a valid MP4/MOV)')
	let ftypNode = find(top, 'ftyp')

	let mvhdNode = find(moovNode.children, 'mvhd')
	let mvhd = readMvhd(bytes, mvhdNode)
	let trakNodes = moovNode.children.filter(n => n.type === 'trak')

	let maxTrackId = 0
	let preserved = []
	for (let trak of trakNodes) {
		let tkhdNode = find(trak.children, 'tkhd')
		let trackId = r32(bytes, tkhdNode.bodyStart + 4 + 8) // FullBox(4) + creation+modification(8) -> track_ID
		maxTrackId = Math.max(maxTrackId, trackId)
		let hdlrNode = findPath(trak.children, 'mdia', 'hdlr')
		let handler = typ4(bytes, hdlrNode.bodyStart + 4 + 4) // FullBox(4) + pre_defined(4)
		if (handler === 'soun') continue // dropped — replaced or removed below
		preserved.push(readPreservedTrak(bytes, trak, trackId))
	}

	let audioTrack = audio instanceof Uint8Array ? extractAudioTrack(audio) : audio || null
	let audioPlan = audioTrack ? planAudioTrack(audioTrack, mvhd.timescale) : null
	let newTrackId = audioTrack ? maxTrackId + 1 : 0
	let nextTrackId = audioTrack ? newTrackId + 1 : Math.max(mvhd.nextTrackId, maxTrackId + 1)

	// interleave: one entry per chunk across every surviving track, sorted by presentation time
	let items = []
	for (let p of preserved) for (let c of p.chunks) items.push({ time: c.time, len: c.size, kind: 'copy', srcOffset: c.offset, chunkRef: c })
	// audio samples for chunk i are a contiguous run in audioTrack.samples — recover [start,count) per chunk
	if (audioTrack) {
		let si = 0
		for (let i = 0; i < audioPlan.chunks.length; i++) {
			let count = audioPlan.chunks[i]
			items.push({ time: audioPlan.chunkTimes[i], len: audioPlan.chunkLens[i], kind: 'audio', sampleStart: si, sampleCount: count, chunkIndex: i })
			si += count
		}
	}
	items.sort((a, b) => a.time - b.time)

	let totalBytes = 0
	for (let it of items) totalBytes += it.len
	// same headroom heuristic as mux.js: total sample bytes alone dwarfs moov+ftyp overhead in any
	// realistic file, so this decides 32- vs 64-bit chunk offsets without a two-pass rebuild
	let forceCo64 = totalBytes > 0xFFFFFFFF - (64 << 20)
	let w = new Writer(Math.max(1 << 16, totalBytes + (1 << 16)))

	// ftyp: keep the source's verbatim; MOV files without one fall back to QuickTime brand
	if (ftypNode) w.bytes(bytes.subarray(ftypNode.start, ftypNode.end))
	else buildFtyp(w, 'qt  ')

	let audioPatches = null
	let creation = mvhd.creation, modification = macTime(new Date())
	w.box('moov', w => {
		let durations = preserved.map(p => p.tkhdDuration)

		let mvhdStart = w.len
		writeMvhd(w, creation, modification, mvhd.timescale, 0 /* patched below, once every track's duration is known */, nextTrackId)

		for (let p of preserved) copyPreservedTrak(bytes, w, p, forceCo64)

		if (audioTrack) {
			let trak = buildAudioTrak(w, audioPlan, audioTrack, opts, { trackId: newTrackId, movieTimescale: mvhd.timescale, creation, forceCo64 })
			audioPatches = trak.patches
			durations.push(audioPlan.movieDuration)
		}

		if (opts.meta || opts.chapters?.length) {
			w.bytes(buildUdta(opts.meta || {}, opts.chapters, {}))
		} else {
			let udtaNode = find(moovNode.children, 'udta')
			if (udtaNode) w.bytes(bytes.subarray(udtaNode.start, udtaNode.end))
		}

		// mvhd = box header(8) + FullBox version/flags(4) + creation(4) + modification(4) + timescale(4) -> duration
		let movieDuration = durations.length ? Math.max(...durations) : 0
		w32(w.buf, mvhdStart + 24, movieDuration)
	})

	let mdatBodyStart = writeMdatHeader(w, totalBytes)

	let off = mdatBodyStart
	for (let it of items) {
		if (it.kind === 'copy') {
			for (let { pos, wide } of it.chunkRef.patch) { if (wide) w64(w.buf, pos, off); else w32(w.buf, pos, off) }
			w.bytes(bytes.subarray(it.srcOffset, it.srcOffset + it.len))
		} else {
			let { pos, wide } = audioPatches[it.chunkIndex]
			if (wide) w64(w.buf, pos, off); else w32(w.buf, pos, off)
			for (let s = 0; s < it.sampleCount; s++) w.bytes(audioTrack.samples[it.sampleStart + s])
		}
		off += it.len
	}

	return w.finish()
}

// ===== moov/mvhd helpers =====

function readMvhd(bytes, node) {
	if (bytes[node.bodyStart] === 1) throw Error('remux: mvhd version 1 (64-bit times) is not supported')
	let o = node.bodyStart + 4 // skip FullBox version/flags
	let creation = r32(bytes, o), timescale = r32(bytes, o + 8), duration = r32(bytes, o + 12)
	let nextTrackId = r32(bytes, node.end - 4)
	return { creation, timescale, duration, nextTrackId }
}

// ===== preserved (non-audio) track passthrough =====

function readPreservedTrak(bytes, trakNode, trackId) {
	let tkhdNode = find(trakNode.children, 'tkhd')
	let tkhdDuration = r32(bytes, tkhdNode.bodyStart + 4 + 4 + 4 + 4 + 4) // FullBox+creation+mod+trackID+reserved -> duration
	let mdia = find(trakNode.children, 'mdia')
	let mdhdNode = find(mdia.children, 'mdhd')
	let mdhdV1 = bytes[mdhdNode.bodyStart] === 1
	let timescale = r32(bytes, mdhdNode.bodyStart + 4 + (mdhdV1 ? 16 : 8))
	let stbl = findPath(trakNode.children, 'mdia', 'minf', 'stbl')
	let sttsNode = find(stbl.children, 'stts')
	let stszNode = find(stbl.children, 'stsz')
	let stscNode = find(stbl.children, 'stsc')
	let stcoNode = find(stbl.children, 'co64') || find(stbl.children, 'stco')
	let stts = parseStts(bytes, sttsNode)
	let stsz = parseStsz(bytes, stszNode)
	let stsc = parseStsc(bytes, stscNode)
	let stco = parseChunkOffsets(bytes, stcoNode)
	let chunks = chunkPlan(stsz, stco, stsc, stts, timescale)
	return { trakNode, stblNode: stbl, stcoNode, chunks, tkhdDuration, trackId }
}

/** One entry per chunk: {offset, size, time (s), count} — offset/size describe the OLD file's mdat range. */
function chunkPlan(stsz, stco, stsc, sttsRuns, timescale) {
	let n = stsz.n, sizeAt = i => stsz.sizes ? stsz.sizes[i] : stsz.constSize
	let runIdx = 0, runLeft = sttsRuns.length ? sttsRuns[0].count : 0, curDelta = sttsRuns.length ? sttsRuns[0].delta : 0
	let timeTicks = 0
	let out = []
	let ci = 0, sInC = 0, spc = spcAt(0, stsc), nextOff = stco[0] ?? 0
	let curStart = nextOff, curTime = 0, curBytes = 0, curCount = 0
	for (let i = 0; i < n; i++) {
		if (sInC === 0) { curStart = nextOff; curTime = timeTicks / timescale; curBytes = 0; curCount = 0 }
		let size = sizeAt(i)
		curBytes += size; curCount++; nextOff += size
		if (runLeft > 0) { timeTicks += curDelta; runLeft-- }
		if (runLeft === 0 && runIdx < sttsRuns.length - 1) { runIdx++; runLeft = sttsRuns[runIdx].count; curDelta = sttsRuns[runIdx].delta }
		sInC++
		let lastSample = i === n - 1
		if (sInC >= spc || lastSample) {
			out.push({ offset: curStart, size: curBytes, time: curTime, count: curCount })
			if (!lastSample) { ci++; sInC = 0; spc = spcAt(ci, stsc); nextOff = stco[ci] }
		}
	}
	return out
}

/** Copy a preserved trak's box tree verbatim, substituting only its stco/co64 box with fresh
 * (zeroed) entries — patch positions land on p.chunks[i].patch, backfilled once mdat's layout is known. */
function copyPreservedTrak(bytes, w, p, forceCo64) {
	copyBoxTree(bytes, w, p.trakNode, node => {
		if (node !== p.stcoNode) return null
		let count = p.chunks.length, patches = new Array(count)
		return {
			write: w => {
				w.fullBox(forceCo64 ? 'co64' : 'stco', 0, 0, w => {
					w.u32(count)
					for (let i = 0; i < count; i++) {
						patches[i] = { pos: w.len, wide: forceCo64 }
						if (forceCo64) w.u64(0); else w.u32(0)
					}
				})
				p.chunks.forEach((c, i) => c.patch = [patches[i]])
			}
		}
	})
}

// ===== extracting a track from a mux()-produced Uint8Array =====

function extractAudioTrack(bytes) {
	let top = parseBoxes(bytes, 0, bytes.length)
	let moov = find(top, 'moov')
	if (!moov) throw Error('remux: audio buffer is not a valid MP4')
	let trak = find(moov.children, 'trak')
	if (!trak) throw Error('remux: audio buffer has no track')
	let mdhdNode = findPath(trak.children, 'mdia', 'mdhd')
	let v1 = bytes[mdhdNode.bodyStart] === 1
	let timescale = r32(bytes, mdhdNode.bodyStart + 4 + (v1 ? 16 : 8))
	let stbl = findPath(trak.children, 'mdia', 'minf', 'stbl')
	let entry = readSampleEntry(bytes, find(stbl.children, 'stsd'))
	let stts = parseStts(bytes, find(stbl.children, 'stts'))
	let stsz = parseStsz(bytes, find(stbl.children, 'stsz'))
	let stsc = parseStsc(bytes, find(stbl.children, 'stsc'))
	let stcoNode = find(stbl.children, 'co64') || find(stbl.children, 'stco')
	let stco = parseChunkOffsets(bytes, stcoNode)

	let n = stsz.n, samples = new Array(n)
	let ci = 0, sInC = 0, spc = spcAt(0, stsc), nextOff = stco[0] ?? 0
	for (let i = 0; i < n; i++) {
		let size = stsz.sizes ? stsz.sizes[i] : stsz.constSize
		samples[i] = bytes.slice(nextOff, nextOff + size)
		nextOff += size; sInC++
		if (sInC >= spc && ci + 1 < stco.length) { ci++; sInC = 0; spc = spcAt(ci, stsc); nextOff = stco[ci] }
	}
	let durations = new Uint32Array(n)
	{ let i = 0; for (let r of stts) for (let k = 0; k < r.count && i < n; k++) durations[i++] = r.delta }

	let { codec, config } = sampleEntryConfig(bytes, entry)

	let track = { codec, sampleRate: entry.sampleRate || timescale, channels: entry.channels, samples, durations, timescale }
	if (config !== undefined) track.config = config

	let edtsNode = findPath(trak.children, 'edts')
	if (edtsNode) {
		let elst = find(edtsNode.children, 'elst')
		if (elst) {
			let d = bytes.subarray(elst.bodyStart + 4, elst.end)
			if (r32(d, 0) >= 1) {
				let mediaTime = r32(d, 8)
				if (mediaTime !== 0xFFFFFFFF) {
					track.priming = mediaTime
					let segDuration = r32(d, 4)
					let presented = Math.round(segDuration / timescale_movie(bytes, moov) * timescale)
					let total = 0; for (let dd of durations) total += dd
					track.padding = Math.max(0, total - track.priming - presented)
				}
			}
		}
	}
	return track
}

function timescale_movie(bytes, moovNode) {
	let mvhdNode = find(moovNode.children, 'mvhd')
	return readMvhd(bytes, mvhdNode).timescale
}

function sampleEntryConfig(bytes, entry) {
	if (entry.type === 'mp4a') {
		let esdsNode = entry.children.find(c => c.type === 'esds')
		let { oti, asc } = parseEsds(bytes.subarray(esdsNode.bodyStart + 4, esdsNode.end))
		if (MP3_OTI.has(oti)) return { codec: 'mp3', config: undefined }
		if (AAC_OTI.has(oti) || !oti) return { codec: 'aac', config: asc }
		throw Error('remux: unsupported esds object type 0x' + oti.toString(16))
	}
	if (entry.type === '.mp3') return { codec: 'mp3', config: undefined }
	if (entry.type === 'alac') {
		let alacNode = entry.children.find(c => c.type === 'alac')
		return { codec: 'alac', config: bytes.subarray(alacNode.bodyStart, alacNode.end).slice(-24) }
	}
	if (entry.type === 'Opus') {
		let dOpsNode = entry.children.find(c => c.type === 'dOps')
		return { codec: 'opus', config: parseDOps(bytes.subarray(dOpsNode.bodyStart, dOpsNode.end)) }
	}
	if (entry.type === 'fLaC') {
		let dfLaNode = entry.children.find(c => c.type === 'dfLa')
		return { codec: 'flac', config: bytes.subarray(dfLaNode.bodyStart + 4, dfLaNode.end) }
	}
	if (entry.type === 'ipcm' || entry.type === 'fpcm') {
		let pcmCNode = entry.children.find(c => c.type === 'pcmC')
		let d = bytes.subarray(pcmCNode.bodyStart + 4, pcmCNode.end) // FormatFlags, PCMSampleSize
		return { codec: 'pcm', config: { bits: d[1], float: entry.type === 'fpcm', be: !(d[0] & 1) } }
	}
	if (QT_PCM_TYPES.has(entry.type)) {
		let endaNode = entry.children.find(c => c.type === 'enda')
		let little = endaNode ? r16(bytes, endaNode.bodyStart) === 1 : entry.type === 'sowt'
		let float = entry.type === 'fl32' || entry.type === 'fl64'
		let bits = entry.type === 'sowt' ? (entry.bits || 16) : entry.type === 'in24' ? 24 : entry.type === 'fl64' ? 64 : 32
		return { codec: 'pcm', config: { bits, float, be: !little } }
	}
	throw Error('remux: unsupported audio sample entry for track extraction: ' + entry.type)
}
const QT_PCM_TYPES = new Set(['sowt', 'twos', 'in24', 'in32', 'fl32', 'fl64'])

function parseEsds(esdsBody) {
	let off = 0
	function readLen() { let len = 0, b; do { b = esdsBody[off++]; len = (len << 7) | (b & 0x7f) } while (b & 0x80); return len }
	function next() { let tag = esdsBody[off++]; let len = readLen(); return { tag, start: off, len } }
	let es = next(); off = es.start + 2 + 1 // ES_ID(2) + flags(1)
	while (off < esdsBody.length) {
		let d = next()
		if (d.tag === 0x04) {
			let oti = esdsBody[d.start], dcdEnd = d.start + d.len
			off = d.start + 13
			while (off < dcdEnd) {
				let dsi = next()
				if (dsi.tag === 0x05) return { oti, asc: esdsBody.subarray(dsi.start, dsi.start + dsi.len) }
				off = dsi.start + dsi.len
			}
			return { oti, asc: null }
		}
		off = d.start + d.len
	}
	return { oti: 0, asc: null }
}

function parseDOps(d) {
	let channels = d[1]
	let opts = { preSkip: r16(d, 2), outputGain: (r16(d, 8) << 16) >> 16 }
	if (d[10] > 0) {
		opts.channelMappingFamily = d[10]
		opts.streamCount = d[11]; opts.coupledStreamCount = d[12]
		opts.channelMappingTable = Array.from(d.subarray(13, 13 + channels))
	}
	return opts
}
