/**
 * Rewrite/insert iTunes-style tags (moov/udta/meta/ilst) and Nero chapters (moov/udta/chpl) into
 * an existing MP4/M4A. Moov is kept first (not relocated to the end): when it grows, every
 * stco/co64 chunk-offset entry in every track is shifted by the same delta, since only udta's
 * byte length changes — mdat's own bytes never move. This is the exact inverse of
 * decode-aac/meta.js's parseMeta for every field it reads (see tags.js for the atom map).
 *
 * writeMeta(bytes, { meta, chapters }) -> Uint8Array
 */
import { Writer, parseBoxes, find, copyBoxTree, r32, r64 } from './iso.js'
import { buildUdta } from './tags.js'

export function writeMeta(bytes, { meta, chapters } = {}) {
	bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
	let top = parseBoxes(bytes, 0, bytes.length)
	let moovNode = find(top, 'moov')
	if (!moovNode) throw Error('writeMeta: no moov box found (not a valid MP4/MOV)')

	let oldUdta = find(moovNode.children, 'udta')
	let oldUdtaSize = oldUdta ? oldUdta.end - oldUdta.start : 0
	let newUdta = buildUdta(meta || {}, chapters, {})
	let delta = newUdta.length - oldUdtaSize

	let firstMdat = top.find(n => n.type === 'mdat')
	let moovPrecedesMdat = firstMdat ? moovNode.start < firstMdat.start : false
	let shift = delta !== 0 && moovPrecedesMdat ? delta : 0

	if (shift) {
		// Growth alone must not push a 32-bit chunk offset past 4GB — upgrading stco->co64 mid-shift
		// would change moov's size again (chasing its own tail), so this stays an explicit limitation.
		for (let stco of chunkTables(moovNode)) {
			if (stco.type === 'co64') continue
			let n = r32(bytes, stco.bodyStart + 4)
			for (let i = 0; i < n; i++)
				if (r32(bytes, stco.bodyStart + 8 + i * 4) + shift > 0xFFFFFFFF)
					throw Error('writeMeta: tag growth would push a 32-bit chunk offset past 4GB (stco->co64 upgrade during meta rewrite is not supported) — remux()/mux() the file instead')
		}
	}

	let w = new Writer(bytes.length + Math.max(0, delta) + 4096)
	w.bytes(bytes.subarray(0, moovNode.start))

	w.box('moov', w => {
		for (let child of moovNode.children) {
			if (child === oldUdta) continue // dropped — replaced below
			copyBoxTree(bytes, w, child, node => {
				if (shift && (node.type === 'stco' || node.type === 'co64')) return { write: w => writeShiftedOffsets(bytes, w, node, shift) }
				return null
			})
		}
		w.bytes(newUdta)
	})

	w.bytes(bytes.subarray(moovNode.end, bytes.length)) // mdat (and anything else) is untouched — only its offsets moved

	return w.finish()
}

function chunkTables(moovNode, out = []) {
	for (let trak of moovNode.children.filter(n => n.type === 'trak')) {
		let mdia = trak.children.find(n => n.type === 'mdia'); if (!mdia) continue
		let minf = mdia.children.find(n => n.type === 'minf'); if (!minf) continue
		let stbl = minf.children.find(n => n.type === 'stbl'); if (!stbl) continue
		let stco = stbl.children.find(n => n.type === 'stco' || n.type === 'co64')
		if (stco) out.push(stco)
	}
	return out
}

function writeShiftedOffsets(bytes, w, node, shift) {
	let wide = node.type === 'co64'
	let n = r32(bytes, node.bodyStart + 4)
	w.fullBox(wide ? 'co64' : 'stco', 0, 0, w => {
		w.u32(n)
		for (let i = 0; i < n; i++) {
			let v = wide ? r64(bytes, node.bodyStart + 8 + i * 8) : r32(bytes, node.bodyStart + 8 + i * 4)
			if (wide) w.u64(v + shift); else w.u32(v + shift)
		}
	})
}
