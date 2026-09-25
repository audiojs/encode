/**
 * ID3v2 metadata writer for MP3 files.
 * @module @audio/encode-mp3/meta
 */

const TE = new TextEncoder()

// ── Constants ───────────────────────────────────────────────────────────

const ID3_MAP_REV = {
  title: 'TIT2', artist: 'TPE1', album: 'TALB', albumartist: 'TPE2',
  composer: 'TCOM', genre: 'TCON', year: 'TDRC', track: 'TRCK',
  disc: 'TPOS', bpm: 'TBPM', key: 'TKEY', copyright: 'TCOP',
  isrc: 'TSRC', publisher: 'TPUB', software: 'TENC',
  comment: 'COMM', lyrics: 'USLT'
}

// ── Binary helpers ──────────────────────────────────────────────────────

function synchsafe(b, o) { return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3] }
function wSynchsafe(b, o, v) { b[o] = (v >>> 21) & 0x7f; b[o + 1] = (v >>> 14) & 0x7f; b[o + 2] = (v >>> 7) & 0x7f; b[o + 3] = v & 0x7f }

// ── ID3v2 builder ───────────────────────────────────────────────────────

function buildId3Frame(id, body) {
  let out = new Uint8Array(10 + body.length)
  out.set(TE.encode(id), 0)
  wSynchsafe(out, 4, body.length)
  out.set(body, 10)
  return out
}

const UNSET = 0xFFFFFFFF
const text = s => { let e = TE.encode(String(s)), b = new Uint8Array(1 + e.length); b[0] = 3; b.set(e, 1); return b }  // UTF-8

/** CTOC + CHAP frames (ID3v2 Chapter Frame Addendum 1.0, id3.org/id3v2-chapters-1.0): chapters
 *  [{ time (s), title }] in order, each ending where the next starts, the last at `end` ms. */
function chapterFrames(chapters, end) {
  if (chapters.length > 255) throw Error('mp3 chapters: at most 255 (CTOC entry count is one byte)')
  let ids = chapters.map((_, i) => TE.encode('chp' + i + '\0'))
  let frames = chapters.map((c, i) => {
    let title = c.title ? buildId3Frame('TIT2', text(c.title)) : new Uint8Array(0)
    let body = new Uint8Array(ids[i].length + 16 + title.length), dv = new DataView(body.buffer), o = ids[i].length
    body.set(ids[i])
    dv.setUint32(o, Math.round(c.time * 1000))
    dv.setUint32(o + 4, i + 1 < chapters.length ? Math.round(chapters[i + 1].time * 1000) : end)
    dv.setUint32(o + 8, UNSET); dv.setUint32(o + 12, UNSET)  // byte offsets: unused
    body.set(title, o + 16)
    return buildId3Frame('CHAP', body)
  })
  // top-level, ordered (flags 0b11), one entry per chapter
  let toc = [TE.encode('toc\0'), Uint8Array.of(0x03, ids.length), ...ids]
  let n = 0; for (let b of toc) n += b.length
  let body = new Uint8Array(n); n = 0
  for (let b of toc) { body.set(b, n); n += b.length }
  return [buildId3Frame('CTOC', body), ...frames]
}

/** ID3v2.4 tag for `meta` and `chapters` ([{ time, title }], seconds), the last chapter ending at
 *  `end` ms (0xFFFFFFFF: unknown yet, a stream still encoding). Null when there is nothing to tag. */
export function id3Tag(meta = {}, chapters = [], end = UNSET) {
  return buildId3v2(meta, [...chapters].sort((a, b) => a.time - b.time), end)
}

function buildId3v2(meta, chapters = [], end = UNSET) {
  let frames = []
  for (let k in ID3_MAP_REV) {
    let v = meta[k]
    if (v == null || v === '') continue
    let id = ID3_MAP_REV[k]
    let body
    if (id === 'COMM' || id === 'USLT') {
      let txt = TE.encode(String(v))
      body = new Uint8Array(1 + 3 + 1 + txt.length + 1)
      body[0] = 3
      body.set(TE.encode('eng'), 1)
      body[4] = 0
      body.set(txt, 5)
      body[body.length - 1] = 0
    } else {
      let enc = TE.encode(String(v))
      body = new Uint8Array(1 + enc.length)
      body[0] = 3
      body.set(enc, 1)
    }
    frames.push(buildId3Frame(id, body))
  }
  if (meta.pictures) {
    for (let p of meta.pictures) {
      let mime = TE.encode((p.mime || 'image/jpeg') + '\0')
      let desc = TE.encode((p.description || '') + '\0')
      let body = new Uint8Array(1 + mime.length + 1 + desc.length + p.data.length)
      body[0] = 3
      let pos = 1
      body.set(mime, pos); pos += mime.length
      body[pos++] = p.type ?? 3
      body.set(desc, pos); pos += desc.length
      body.set(p.data, pos)
      frames.push(buildId3Frame('APIC', body))
    }
  }

  if (chapters.length) frames.push(...chapterFrames(chapters, end))

  if (!frames.length) return null
  let totalFrameSize = frames.reduce((n, f) => n + f.length, 0)
  let out = new Uint8Array(10 + totalFrameSize)
  out[0] = 0x49; out[1] = 0x44; out[2] = 0x33
  out[3] = 4; out[4] = 0; out[5] = 0
  wSynchsafe(out, 6, totalFrameSize)
  let pos = 10
  for (let f of frames) { out.set(f, pos); pos += f.length }
  return out
}

function stripMp3Tags(bytes) {
  let start = 0, end = bytes.length
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    start = 10 + synchsafe(bytes, 6)
  }
  if (bytes.length >= 128 && bytes[end - 128] === 0x54 && bytes[end - 127] === 0x41 && bytes[end - 126] === 0x47) {
    end -= 128
  }
  return bytes.subarray(start, end)
}

/** Duration of MPEG audio frames in ms (Layer III: 1152 samples a frame, 576 for MPEG-2/2.5). */
function duration(b) {
  const RATE = [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]]
  const KBPS1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
  const KBPS2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  let samples = 0, rate = 0
  for (let o = 0; o + 4 <= b.length;) {
    if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) { o++; continue }
    let v = (b[o + 1] >> 3) & 3, br = b[o + 2] >> 4, sr = (b[o + 2] >> 2) & 3, pad = (b[o + 2] >> 1) & 1
    if (v === 1 || br === 0 || br === 15 || sr === 3 || ((b[o + 1] >> 1) & 3) !== 1) { o++; continue }
    rate = RATE[v][sr]
    let mpeg1 = v === 3, kbps = (mpeg1 ? KBPS1 : KBPS2)[br]
    samples += mpeg1 ? 1152 : 576
    o += Math.floor((mpeg1 ? 144000 : 72000) * kbps / rate) + pad
  }
  return rate ? Math.round(samples / rate * 1000) : 0
}

/** Splice an ID3v2 tag (meta, chapters) into MP3 bytes. Returns new Uint8Array. The last chapter
 *  ends at `duration` (seconds of input), else where the frames end (with the encoder's padding). */
export function writeMeta(bytes, { meta = {}, chapters = [], duration: sec } = {}) {
  let audio = stripMp3Tags(bytes)
  let tag = id3Tag(meta, chapters, !chapters.length ? UNSET : sec > 0 ? Math.round(sec * 1000) : duration(audio))
  if (!tag) return audio
  let out = new Uint8Array(tag.length + audio.length)
  out.set(tag, 0)
  out.set(audio, tag.length)
  return out
}
