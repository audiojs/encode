/**
 * iTunes-style metadata atoms — moov/udta/meta/ilst (+ Nero udta/chpl chapters).
 * Internal module shared by mux.js (opts.meta/opts.chapters) and meta.js (writeMeta).
 *
 * Key names and atom codes are the exact inverse of decode-aac/meta.js's ILST_MAP, so
 * `parseMeta(bytes).meta` round-trips through `buildUdta` for every field that parser reads:
 * title, artist, albumartist, album, year, genre, composer, comment, software, copyright,
 * lyrics, track, disc, bpm, pictures. trkn/disk/tmpo payload layout matches applyTag's
 * `r16(payload, 2)` / `r16(payload, 0)` reads exactly (see decode-aac/meta.js).
 *
 * Freeform '----' tags (isrc, key, publisher, iTunSMPB) follow the mean="com.apple.iTunes"
 * convention documented by mutagen (mutagen.mp4) and AtomicParsley — write-only: no shipped
 * MP4 parser in this ecosystem reads them back yet.
 */
import { Writer, concat } from './iso.js'

const C = '©' // copyright sign — iTunes text atom prefix
const TE = new TextEncoder()

// meta key -> ilst atom code, text atoms only (binary atoms handled separately below)
export const TEXT_ATOMS = {
	title: C + 'nam', artist: C + 'ART', albumartist: 'aART', album: C + 'alb',
	year: C + 'day', genre: C + 'gen', composer: C + 'wrt', comment: C + 'cmt',
	software: C + 'too', copyright: 'cprt', lyrics: C + 'lyr',
}

const FREEFORM_NAME = { isrc: 'ISRC', key: 'initialkey', publisher: 'LABEL' }

function dataAtom(w, name, flags, payload) {
	w.box(name, w => w.box('data', w => w.u8(0).u24(flags).u32(0).bytes(payload)))
}

function textAtom(w, name, value) { dataAtom(w, name, 1, TE.encode(String(value))) }

function freeformAtom(w, name, value) {
	w.box('----', w => {
		w.box('mean', w => w.u32(0).ascii('com.apple.iTunes'))
		w.box('name', w => w.u32(0).ascii(name))
		w.box('data', w => w.u8(0).u24(1).u32(0).bytes(TE.encode(String(value))))
	})
}

// "3", "3/12", 3 -> [num, total]
function pair(v) {
	let [n, t] = String(v).split('/')
	return [Number(n) || 0, Number(t) || 0]
}

function trknAtom(w, value) {
	let [track, total] = pair(value)
	let p = new Uint8Array(8) // reserved(2) track(2) total(2) reserved(2) — matches applyTag r16(payload,2)
	p[2] = (track >> 8) & 0xFF; p[3] = track & 0xFF
	p[4] = (total >> 8) & 0xFF; p[5] = total & 0xFF
	dataAtom(w, 'trkn', 0, p)
}

function diskAtom(w, value) {
	let [disc, total] = pair(value)
	let p = new Uint8Array(6) // reserved(2) disc(2) total(2) — matches applyTag r16(payload,2)
	p[2] = (disc >> 8) & 0xFF; p[3] = disc & 0xFF
	p[4] = (total >> 8) & 0xFF; p[5] = total & 0xFF
	dataAtom(w, 'disk', 0, p)
}

function tmpoAtom(w, value) {
	let p = new Uint8Array(2), v = Math.round(Number(value)) & 0xFFFF
	p[0] = (v >> 8) & 0xFF; p[1] = v & 0xFF
	dataAtom(w, 'tmpo', 21, p) // 21 = BE signed integer, the well-known-type iTunes uses for tempo
}

function covrAtom(w, pic) {
	let mime = (pic.mime || '').toLowerCase()
	let flags = mime.includes('png') ? 14 : 13 // matches decode-aac/meta.js applyTag: 14=png, 13=jpeg (default)
	dataAtom(w, 'covr', flags, pic.data instanceof Uint8Array ? pic.data : new Uint8Array(pic.data))
}

/** Build the 'ilst' box body from a meta object. `itunSmpb`, if given, adds the AAC gapless freeform tag. */
export function buildIlst(meta = {}, { itunSmpb } = {}) {
	let w = new Writer(4096)
	w.box('ilst', w => {
		for (let key in TEXT_ATOMS) if (meta[key] != null && meta[key] !== '') textAtom(w, TEXT_ATOMS[key], meta[key])
		if (meta.track != null) trknAtom(w, meta.track)
		if (meta.disc != null) diskAtom(w, meta.disc)
		if (meta.bpm != null) tmpoAtom(w, meta.bpm)
		for (let pic of meta.pictures || []) covrAtom(w, pic)
		for (let key in FREEFORM_NAME) if (meta[key] != null && meta[key] !== '') freeformAtom(w, FREEFORM_NAME[key], meta[key])
		if (itunSmpb) freeformAtom(w, 'iTunSMPB', itunSmpb)
	})
	return w.finish()
}

/**
 * iTunSMPB gapless-playback tag (mp4v2/AtomicParsley convention, undocumented by Apple but
 * universally honored by iTunes/QuickTime/ffmpeg/foobar2000): a space-separated string of
 * hex fields — reserved, encoder delay, encoder padding, original sample count (64-bit), then
 * six reserved zero fields.
 */
export function itunSmpb(priming, padding, originalSampleCount) {
	let hex8 = n => (n >>> 0).toString(16).padStart(8, '0')
	let hex16 = n => {
		let hi = Math.floor(n / 0x100000000) >>> 0, lo = n >>> 0
		return hex8(hi) + hex8(lo)
	}
	return ` ${hex8(0)} ${hex8(priming)} ${hex8(padding)} ${hex16(originalSampleCount)} ${hex8(0)} ${hex8(0)} ${hex8(0)} ${hex8(0)} ${hex8(0)} ${hex8(0)}`
}

/** Nero chapter list: udta/chpl. Format per ffmpeg libavformat/movenc.c mov_write_chpl_tag. */
export function buildChpl(chapters) {
	let w = new Writer(1024)
	w.fullBox('chpl', 1, 0, w => {
		w.u32(0) // reserved
		w.u8(Math.min(chapters.length, 255))
		for (let c of chapters.slice(0, 255)) {
			w.u64(Math.round(c.time * 1e7)) // start time, 100ns ticks
			let title = TE.encode(String(c.title ?? '').slice(0, 255))
			w.u8(title.length).bytes(title)
		}
	})
	return w.finish()
}

/** moov/udta/meta(hdlr mdir)/ilst [+ chpl] — the full metadata sub-tree ffmpeg/iTunes expect. */
export function buildUdta(meta, chapters, extra) {
	let w = new Writer(4096)
	w.box('udta', w => {
		w.fullBox('meta', 0, 0, w => {
			w.fullBox('hdlr', 0, 0, w => {
				w.u32(0)            // pre_defined
				w.ascii('mdir')     // handler_type
				w.ascii('appl')     // reserved[0], conventionally the manufacturer 'appl' (ffmpeg/iTunes convention)
				w.u32(0).u32(0)     // reserved[1..2]
				w.u8(0)             // empty name, null-terminated
			})
			w.bytes(buildIlst(meta, extra))
		})
		if (chapters?.length) w.bytes(buildChpl(chapters))
	})
	return w.finish()
}
