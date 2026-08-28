/**
 * ISO/IEC 14496-12 (ISOBMFF) primitives shared by mux.js, remux.js and meta.js.
 * Internal module — not part of the public API (see ./mux, ./remux, ./meta, .).
 */

// ── growable byte writer — one preallocated buffer, doubles on overflow ──
export class Writer {
	constructor(cap = 1 << 16) { this.buf = new Uint8Array(cap); this.len = 0 }
	ensure(n) {
		if (this.len + n <= this.buf.length) return
		let cap = this.buf.length || 1024
		while (cap < this.len + n) cap *= 2
		let nb = new Uint8Array(cap)
		nb.set(this.buf.subarray(0, this.len))
		this.buf = nb
	}
	u8(v) { this.ensure(1); this.buf[this.len++] = v & 0xFF; return this }
	u16(v) { this.ensure(2); let b = this.buf, o = this.len; b[o] = (v >>> 8) & 0xFF; b[o + 1] = v & 0xFF; this.len += 2; return this }
	i16(v) { return this.u16(v < 0 ? v + 0x10000 : v) }
	u24(v) { this.ensure(3); let b = this.buf, o = this.len; b[o] = (v >>> 16) & 0xFF; b[o + 1] = (v >>> 8) & 0xFF; b[o + 2] = v & 0xFF; this.len += 3; return this }
	u32(v) { this.ensure(4); let b = this.buf, o = this.len; b[o] = (v >>> 24) & 0xFF; b[o + 1] = (v >>> 16) & 0xFF; b[o + 2] = (v >>> 8) & 0xFF; b[o + 3] = v & 0xFF; this.len += 4; return this }
	i32(v) { return this.u32(v < 0 ? v + 0x100000000 : v) }
	// 64-bit unsigned, split as two u32 (safe to 2^53 — plenty for byte offsets/durations)
	u64(v) { let hi = Math.floor(v / 0x100000000), lo = v >>> 0; this.u32(hi); this.u32(lo); return this }
	// Q16.16 fixed point (rates, matrix unity)
	fixed1616(v) { let i = Math.trunc(v), f = Math.round((v - i) * 65536); this.u16(i & 0xFFFF).u16(f & 0xFFFF); return this }
	// Q8.8 fixed point (volume)
	fixed88(v) { let i = Math.trunc(v), f = Math.round((v - i) * 256); this.u8(i & 0xFF).u8(f & 0xFF); return this }
	bytes(arr) { if (!arr || !arr.length) return this; this.ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; return this }
	ascii(s) { this.ensure(s.length); for (let i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i) & 0xFF; return this }
	zero(n) { this.ensure(n); this.len += n; return this } // Uint8Array is zero-initialized
	/** box(type, fn): writes size(4)+fourcc(4), runs fn(this), backpatches the size. Returns the box's start offset. */
	box(type, fn) {
		let start = this.len
		this.u32(0).ascii(type)
		fn(this)
		let size = this.len - start, b = this.buf
		b[start] = (size >>> 24) & 0xFF; b[start + 1] = (size >>> 16) & 0xFF; b[start + 2] = (size >>> 8) & 0xFF; b[start + 3] = size & 0xFF
		return start
	}
	fullBox(type, version, flags, fn) { return this.box(type, w => { w.u8(version).u24(flags); fn(w) }) }
	finish() { return this.buf.subarray(0, this.len) }
}

// ── big-endian binary readers ──
export function r8(b, o) { return b[o] }
export function r16(b, o) { return (b[o] << 8) | b[o + 1] }
export function r32(b, o) { return ((b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]) >>> 0 }
export function r64(b, o) { return r32(b, o) * 0x100000000 + r32(b, o + 4) }
export function typ4(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) }
export function w32(b, o, v) { b[o] = (v >>> 24) & 0xFF; b[o + 1] = (v >>> 16) & 0xFF; b[o + 2] = (v >>> 8) & 0xFF; b[o + 3] = v & 0xFF }
export function w64(b, o, v) { w32(b, o, Math.floor(v / 0x100000000)); w32(b, o + 4, v >>> 0) }

// ── generic box walker — structural only, does not interpret payloads ──
// Node: { type, start, end, headerSize, bodyStart, children: Node[] | null }
// Handles size 0 (box runs to end), size 1 (64-bit extended size), 'uuid' (opaque 16-byte usertype
// box — no special-casing needed since we never interpret uuid payloads, only preserve or skip them),
// 'meta' (a FullBox despite being a container — version/flags(4) precede its children), and stops
// cleanly on a truncated trailing box instead of throwing (callers decide whether that's fatal).
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'mvex', 'sinf', 'schi', 'wave', 'ilst'])

export function parseBoxes(buf, start, end) {
	let boxes = []
	let off = start
	while (off + 8 <= end) {
		let size = r32(buf, off), type = typ4(buf, off + 4), headerSize = 8
		if (size === 1) {
			if (off + 16 > end) break
			size = r64(buf, off + 8); headerSize = 16
		} else if (size === 0) size = end - off
		if (size < headerSize || off + size > end) break
		let bodyStart = off + headerSize
		let node = { type, start: off, end: off + size, headerSize, bodyStart, children: null }
		if (type === 'meta') node.children = parseBoxes(buf, bodyStart + 4, off + size) // FullBox: skip version+flags
		else if (CONTAINERS.has(type)) node.children = parseBoxes(buf, bodyStart, off + size)
		boxes.push(node)
		off += size
	}
	return boxes
}

export function find(nodes, type) { return nodes?.find(n => n.type === type) ?? null }
export function findPath(nodes, ...types) {
	let cur = nodes, node = null
	for (let t of types) { node = find(cur, t); if (!node) return null; cur = node.children }
	return node
}
export function findAll(nodes, type, out = []) {
	if (!nodes) return out
	for (let n of nodes) { if (n.type === type) out.push(n); if (n.children) findAll(n.children, type, out) }
	return out
}

// ── sample-table readers (generic — any codec/track type) ──
export function fullBody(buf, node) { return buf.subarray(node.bodyStart + 4, node.end) } // skip FullBox version/flags

export function parseStts(buf, node) {
	let d = fullBody(buf, node), n = r32(d, 0), runs = new Array(n)
	for (let i = 0; i < n; i++) runs[i] = { count: r32(d, 4 + i * 8), delta: r32(d, 8 + i * 8) }
	return runs
}
export function parseStsz(buf, node) {
	let d = fullBody(buf, node), sz = r32(d, 0), n = r32(d, 4)
	if (sz) return { constSize: sz, n }
	let sizes = new Uint32Array(n)
	for (let i = 0; i < n; i++) sizes[i] = r32(d, 8 + i * 4)
	return { sizes, n }
}
export function parseStsc(buf, node) {
	let d = fullBody(buf, node), n = r32(d, 0), out = new Array(n)
	for (let i = 0; i < n; i++) out[i] = { first: r32(d, 4 + i * 12), spc: r32(d, 8 + i * 12) }
	return out
}
/** node must be a 'stco' or 'co64' box. */
export function parseChunkOffsets(buf, node) {
	let wide = node.type === 'co64'
	let d = fullBody(buf, node), n = r32(d, 0), out = new Array(n)
	for (let i = 0; i < n; i++) out[i] = wide ? r64(d, 4 + i * 8) : r32(d, 4 + i * 4)
	return out
}
export function spcAt(chunkIndex, stsc) {
	let spc = 1, cn = chunkIndex + 1
	for (let j = stsc.length - 1; j >= 0; j--) if (cn >= stsc[j].first) { spc = stsc[j].spc; break }
	return spc
}
/** Every sample's absolute {offset, size} in file order, from parsed stsz/stco/stsc. */
export function enumerateSamples(stsz, stco, stsc) {
	let n = stsz.n, out = new Array(n)
	let ci = 0, sInC = 0, spc = spcAt(0, stsc), nextOff = stco[0] ?? 0
	for (let i = 0; i < n; i++) {
		let size = stsz.sizes ? stsz.sizes[i] : stsz.constSize
		out[i] = { offset: nextOff, size }
		nextOff += size; sInC++
		if (sInC >= spc && ci + 1 < stco.length) { ci++; sInC = 0; spc = spcAt(ci, stsc); nextOff = stco[ci] }
	}
	return out
}

/** Read a stsd box's first sample entry: type, audio fields (v0 layout), and its child config boxes. */
export function readSampleEntry(buf, stsdNode) {
	let entryStart = stsdNode.bodyStart + 8 // FullBox(4) + entry_count(4)
	let size = r32(buf, entryStart), type = typ4(buf, entryStart + 4)
	let ver = r16(buf, entryStart + 16)
	let channels = r16(buf, entryStart + 24)
	let bits = r16(buf, entryStart + 26)
	let sampleRate = r16(buf, entryStart + 32)
	let head = ver === 1 ? 52 : ver === 2 ? r32(buf, entryStart + 36) : 36
	let children = size > head ? parseBoxes(buf, entryStart + head, entryStart + size) : []
	return { type, ver, channels, bits, sampleRate, entryStart, entryEnd: entryStart + size, children }
}

/**
 * Copy a box subtree into a Writer, verbatim except where `substitute(node)` intervenes.
 * substitute(node) returns:
 *   undefined/null -> copy this node normally (verbatim if leaf, recurse if container)
 *   { skip: true } -> omit this node entirely
 *   { write: fn }  -> call fn(w) instead of copying this node
 * Re-wrapping containers through Writer#box recomputes every ancestor's size for free —
 * no manual delta bookkeeping needed when a descendant substitution changes length.
 */
export function copyBoxTree(buf, w, node, substitute) {
	let action = substitute(node)
	if (action?.skip) return
	if (action?.write) { action.write(w); return }
	if (!node.children) { w.bytes(buf.subarray(node.start, node.end)); return }
	if (node.type === 'meta') {
		w.box('meta', w => { w.bytes(buf.subarray(node.bodyStart, node.bodyStart + 4)); for (let c of node.children) copyBoxTree(buf, w, c, substitute) })
	} else {
		w.box(node.type, w => { for (let c of node.children) copyBoxTree(buf, w, c, substitute) })
	}
}

export function concat(parts) {
	let total = 0
	for (let p of parts) total += p.length
	let out = new Uint8Array(total), off = 0
	for (let p of parts) { out.set(p, off); off += p.length }
	return out
}
