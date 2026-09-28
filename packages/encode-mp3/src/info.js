// Xing/Info frame with the LAME tag: the frame count, byte count and seek TOC, and the encoder delay and
// padding a decoder trims for gapless playback (LAME's VbrTag.c; "Mp3 Info Tag rev 1", G. Bouvigne).
// The frame leads the audio frames; it holds no audio itself (zero side info).

const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }
export const DELAY = 576 // LAME's encoder delay (ENCDELAY), in output samples
const TAG = 156 // Xing header (4 id + 4 flags + 4 frames + 4 bytes + 100 TOC + 4 quality) + LAME extension (36)

/** MPEG-1/2/2.5 Layer III frame header at b[i], or null. */
export function header(b, i = 0) {
	if (i + 4 > b.length || b[i] !== 0xFF || (b[i + 1] & 0xE0) !== 0xE0) return null
	let v = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, bri = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3
	if (v === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) return null
	let mpeg1 = v === 3, sampleRate = SR[v][sri], mono = (b[i + 3] >> 6) === 3
	let bitrate = (mpeg1 ? BR1 : BR2)[bri]
	return {
		v, mpeg1, bri, sampleRate, bitrate, mono, b3: b[i + 3],
		spf: mpeg1 ? 1152 : 576,
		side: mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17),
		size: Math.floor((mpeg1 ? 144000 : 72000) * bitrate / sampleRate) + ((b[i + 2] >> 1) & 1)
	}
}

// CRC-16/ARC (reflected 0x8005, init 0): the LAME tag's music and tag CRCs
const CRC = new Uint16Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xA001 : c >>> 1; return c })
export const crc16 = (b, c = 0, from = 0, to = b.length) => { for (let i = from; i < to; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return c }

/** Frame size for the tag: the stream's own bitrate when the tag fits (CBR players read it), else the
 *  smallest that does (LAME writes VBR tags at 128 kbps, ffmpeg picks the smallest that fits). */
function tagBitrate(h, vbr) {
	let table = h.mpeg1 ? BR1 : BR2, need = 4 + h.side + TAG
	let fits = i => Math.floor((h.mpeg1 ? 144000 : 72000) * table[i] / h.sampleRate) >= need
	if (!vbr && fits(h.bri)) return h.bri
	for (let i = 1; i < 15; i++) if (fits(i)) return i
	return 14
}

/**
 * Tracks the audio frames as they are emitted; frame() gives the Info frame: a placeholder while
 * streaming, the final one after the end.
 * @param {{ vbr: boolean, quality?: number }} opts
 */
export function info({ vbr, quality }) {
	let first = null, bri = 0, size = 0
	let frames = 0, bytes = 0, crc = 0, minBr = Infinity
	let rest = null // bytes of a frame split across chunks
	// frame offsets for the TOC, every `step`th frame; the step doubles to keep memory flat
	let offs = [], step = 1

	/** Scan emitted audio bytes (whole or split frames: LAME may end a chunk mid-frame). */
	function scan(b) {
		if (!b.length) return
		crc = crc16(b, crc)
		if (rest) { let m = new Uint8Array(rest.length + b.length); m.set(rest); m.set(b, rest.length); b = m; rest = null }
		// the first header sizes the Info frame, which must go out before any audio byte
		if (!first && (first = header(b, 0))) { bri = tagBitrate(first, vbr); size = header(prefix(first, bri), 0).size }
		let i = 0
		while (i + 4 <= b.length) {
			let h = header(b, i)
			if (!h) { i++; continue } // encoders emit whole frames; resync defensively
			if (i + h.size > b.length) break
			if (frames % step === 0) {
				offs.push(bytes)
				if (offs.length > 2048) { offs = offs.filter((_, k) => k % 2 === 0); step *= 2 }
			}
			frames++; bytes += h.size; minBr = Math.min(minBr, h.bitrate)
			i += h.size
		}
		if (i < b.length) rest = b.slice(i)
	}

	/** The Info frame. `samples`: the audio's length at the output rate. `end`: every frame scanned, the
	 *  final frame exact. Before the end, the placeholder of the same size: with `samples` known upfront its
	 *  frame count and padding are exact already (LAME's framing, lameFrames), so a pipe that never gets the
	 *  final frame still plays gapless; else they read 0, "unknown", and a decoder trims only the delay. */
	function frame(samples, end) {
		if (!first) return null
		let h = first, out = new Uint8Array(size), dv = new DataView(out.buffer), x = 4 + h.side, l = x + 120
		let n = end ? frames : samples != null ? lameFrames(samples, h.spf) : 0
		let pad = n ? Math.max(0, Math.min(4095, n * h.spf - DELAY - samples)) : 0
		out.set(prefix(h, bri))
		out.set(vbr ? [0x58, 0x69, 0x6E, 0x67] : [0x49, 0x6E, 0x66, 0x6F], x) // 'Xing' | 'Info'
		dv.setUint32(x + 4, 0x0F) // fields: frames, bytes, TOC, quality
		dv.setUint32(x + 8, n)
		dv.setUint32(x + 12, end ? size + bytes : 0)
		// TOC: byte position at each percent of the duration, /256; upfront, a constant bitrate's line
		if (n) for (let p = 0; p < 100; p++) out[x + 16 + p] = !end ? Math.floor(256 * p / 100)
			: Math.min(255, Math.floor(256 * (size + offs[Math.min(Math.floor(p * frames / 100 / step), offs.length - 1)]) / (size + bytes)))
		dv.setUint32(x + 116, Math.max(0, Math.min(100, 100 - 10 * (quality ?? 4) - 3))) // LAME: 100 - 10·VBR_q - quality (3)
		out.set([0x4C, 0x41, 0x4D, 0x45, 0x33, 0x2E, 0x31, 0x30, 0x30], l) // 'LAME3.100': decoders read the delays after it
		out[l + 9] = vbr ? 4 : 1 // tag revision 0; VBR method: 1 CBR, 4 VBR (mtrh, LAME's -V)
		out[l + 20] = Math.min(255, vbr ? (minBr === Infinity ? 0 : minBr) : h.bitrate)
		out[l + 21] = DELAY >> 4; out[l + 22] = ((DELAY & 15) << 4) | (pad >> 8); out[l + 23] = pad & 0xFF
		dv.setUint32(l + 28, end ? size + bytes : 0) // music length, this frame included
		dv.setUint16(l + 32, end ? crc : 0) // music CRC
		dv.setUint16(l + 34, crc16(out, 0, 0, l + 34)) // tag CRC
		return out
	}

	return { scan, frame, get header() { return first } }
}

// Frames LAME codes `samples` into (lame_encode_flush): the delay, the audio, then padding to a whole frame,
// at least 576 samples of it, so the last granule decodes completely
function lameFrames(samples, spf) {
	let s = DELAY + samples, pad = spf - s % spf
	if (pad < 576) pad += spf
	return (s + pad) / spf
}

// the stream's first header at another bitrate: no CRC, no padding, no mode extension
function prefix(h, bri) {
	return Uint8Array.of(0xFF, 0xE0 | (h.v << 3) | (1 << 1) | 1, (bri << 4) | (SR[h.v].indexOf(h.sampleRate) << 2), h.b3 & 0xCF)
}
