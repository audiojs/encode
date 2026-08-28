// Test-only helpers: read an ffmpeg-authored MP4/M4A fixture's audio track (sample entry config +
// per-AU samples + durations) so tests can feed real, ffmpeg-encoded bitstreams through mux()/remux()
// and diff the result against ffmpeg/ffprobe — an authoritative reference instead of hand-picked bytes.
import { parseBoxes, find, findPath, r16, r32, r64, typ4 } from './iso.js'

function fullBody(bytes, node) { return bytes.subarray(node.bodyStart + 4, node.end) }

function parseStts(bytes, node) {
	let d = fullBody(bytes, node), n = r32(d, 0), runs = []
	for (let i = 0; i < n; i++) runs.push({ count: r32(d, 4 + i * 8), delta: r32(d, 8 + i * 8) })
	return runs
}
function parseStsz(bytes, node) {
	let d = fullBody(bytes, node), sz = r32(d, 0), n = r32(d, 4)
	if (sz) return new Array(n).fill(sz)
	let out = new Array(n)
	for (let i = 0; i < n; i++) out[i] = r32(d, 8 + i * 4)
	return out
}
function parseStsc(bytes, node) {
	let d = fullBody(bytes, node), n = r32(d, 0), out = new Array(n)
	for (let i = 0; i < n; i++) out[i] = { first: r32(d, 4 + i * 12), spc: r32(d, 8 + i * 12) }
	return out
}
function parseStco(bytes, node, wide) {
	let d = fullBody(bytes, node), n = r32(d, 0), out = new Array(n)
	for (let i = 0; i < n; i++) out[i] = wide ? r64(d, 4 + i * 8) : r32(d, 4 + i * 4)
	return out
}
function spcAt(ci, stsc) {
	let spc = 1, cn = ci + 1
	for (let j = stsc.length - 1; j >= 0; j--) if (cn >= stsc[j].first) { spc = stsc[j].spc; break }
	return spc
}

/** Enumerate every sample's absolute {offset,size} in file order. */
function enumerateSamples(sizes, stco, stsc) {
	let out = new Array(sizes.length)
	let ci = 0, sInC = 0, spc = spcAt(0, stsc), nextOff = stco[0]
	for (let i = 0; i < sizes.length; i++) {
		out[i] = { offset: nextOff, size: sizes[i] }
		nextOff += sizes[i]; sInC++
		if (sInC >= spc && ci + 1 < stco.length) { ci++; sInC = 0; spc = spcAt(ci, stsc); nextOff = stco[ci] }
	}
	return out
}

function expandDurations(runs) {
	let n = 0
	for (let r of runs) n += r.count
	let out = new Uint32Array(n), i = 0
	for (let r of runs) for (let k = 0; k < r.count; k++) out[i++] = r.delta
	return out
}

/**
 * Read every trak of an MP4/MOV file. Returns [{ handler, type, config, bits, channels, sampleRate,
 * timescale, samples: Uint8Array[], durations: Uint32Array, chunkPattern: number[] }]
 * `config` is the sample entry's children region (esds/alac/dOps/dfLa/pcmC/enda as a parsed subtree).
 */
export function readTracks(bytes) {
	let top = parseBoxes(bytes, 0, bytes.length)
	let moov = find(top, 'moov')
	if (!moov) throw Error('test-helpers: no moov box')
	let traks = moov.children.filter(n => n.type === 'trak')
	return traks.map(trak => {
		let mdia = find(trak.children, 'mdia')
		let mdhd = find(mdia.children, 'mdhd')
		let hdlr = find(mdia.children, 'hdlr')
		let handler = typ4(bytes, hdlr.bodyStart + 4 + 4) // FullBox(4) + pre_defined(4) -> handler_type
		let version = bytes[mdhd.bodyStart + 4]
		let timescale = r32(bytes, mdhd.bodyStart + 4 + (version === 1 ? 20 : 12))
		let stbl = findPath(trak.children, 'mdia', 'minf', 'stbl')
		let stsdNode = find(stbl.children, 'stsd')
		let entryStart = stsdNode.bodyStart + 8 // FullBox(4) + entry_count(4)
		let entrySize = r32(bytes, entryStart)
		let entryType = typ4(bytes, entryStart + 4)
		let entryVer = r16(bytes, entryStart + 16)
		let channels = r16(bytes, entryStart + 24)
		let bits = r16(bytes, entryStart + 26)
		let sampleRate = r16(bytes, entryStart + 32)
		let head = entryVer === 1 ? 52 : entryVer === 2 ? r32(bytes, entryStart + 36) : 36
		let configChildren = entrySize > head ? parseBoxes(bytes, entryStart + head, entryStart + entrySize) : []

		let stts = parseStts(bytes, find(stbl.children, 'stts'))
		let stsz = parseStsz(bytes, find(stbl.children, 'stsz'))
		let stsc = parseStsc(bytes, find(stbl.children, 'stsc'))
		let co64Node = find(stbl.children, 'co64')
		let stco = co64Node ? parseStco(bytes, co64Node, true) : parseStco(bytes, find(stbl.children, 'stco'), false)

		let ranges = enumerateSamples(stsz, stco, stsc)
		let samples = ranges.map(r => bytes.slice(r.offset, r.offset + r.size))
		let durations = expandDurations(stts)

		return { handler, type: entryType, configChildren, channels, bits, sampleRate, timescale, samples, durations }
	})
}

/** Read the first track's edit-list trim: { priming, padding } in the track's own media timescale, or null. */
export function readEditList(bytes) {
	let top = parseBoxes(bytes, 0, bytes.length)
	let trak = findPath(top, 'moov', 'trak')
	let elst = findPath(trak.children, 'edts', 'elst')
	if (!elst) return null
	let d = fullBody(bytes, elst)
	let mvhd = findPath(top, 'moov', 'mvhd')
	let movieTimescale = r32(bytes, mvhd.bodyStart + 4 + 8)
	let mdhd = findPath(trak.children, 'mdia', 'mdhd')
	let timescale = r32(bytes, mdhd.bodyStart + 4 + 8)
	let sttsRuns = parseStts(bytes, findPath(trak.children, 'mdia', 'minf', 'stbl', 'stts'))
	let total = 0; for (let r of sttsRuns) total += r.count * r.delta
	let priming = r32(d, 8)
	let presented = Math.round(r32(d, 4) / movieTimescale * timescale)
	return { priming, padding: Math.max(0, total - priming - presented) }
}

/** Find a config child box's raw bytes (children region content) by type, e.g. 'esds', 'dOps', 'dfLa', 'alac'. */
export function configBytes(bytes, track, type) {
	let node = track.configChildren.find(n => n.type === type)
	if (!node) return null
	return bytes.subarray(node.bodyStart, node.end) // FullBox body incl. version/flags for FullBoxes
}

/** esds -> raw AudioSpecificConfig (DecoderSpecificInfo, tag 0x05) */
export function ascFromEsds(esdsBody) {
	// esdsBody starts with FullBox version/flags(4), then ES_Descriptor (tag 0x03)
	let off = 4
	function readLen() { let len = 0, b; do { b = esdsBody[off++]; len = (len << 7) | (b & 0x7f) } while (b & 0x80); return len }
	function next() { let tag = esdsBody[off++]; let len = readLen(); return { tag, start: off, len } }
	let es = next(); off = es.start // enter ES_Descriptor body
	off += 2 + 1 // ES_ID(2) + flags(1) — no optional fields assumed (matches ffmpeg's plain esds)
	while (off < esdsBody.length) {
		let d = next()
		if (d.tag === 0x04) {
			let dcdEnd = d.start + d.len
			off = d.start + 13 // objectTypeIndication+streamType+bufferSizeDB+maxBitrate+avgBitrate
			while (off < dcdEnd) {
				let dsi = next()
				if (dsi.tag === 0x05) return esdsBody.subarray(dsi.start, dsi.start + dsi.len)
				off = dsi.start + dsi.len
			}
		}
		off = d.start + d.len
	}
	return null
}

export function sine(sr, freq, dur, amp = 0.5) {
	let n = Math.floor(sr * dur), d = new Float32Array(n)
	for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * freq * i / sr) * amp
	return d
}

export function rms(arr) {
	let sum = 0
	for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i]
	return Math.sqrt(sum / arr.length)
}

/** SNR in dB of `test` vs `ref` (same length; ref treated as signal, test-ref as noise). */
export function snr(ref, test) {
	let n = Math.min(ref.length, test.length)
	let sigE = 0, noiseE = 0
	for (let i = 0; i < n; i++) {
		sigE += ref[i] * ref[i]
		let e = test[i] - ref[i]
		noiseE += e * e
	}
	if (noiseE === 0) return Infinity
	return 10 * Math.log10(sigE / noiseE)
}
