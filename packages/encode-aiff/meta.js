/**
 * AIFF metadata writer — ID3v2 tag spliced as an "ID3 " chunk.
 * @module @audio/encode-aiff/meta
 *
 * AIFF carries full ID3v2 (same frames as MP3) inside a FORM chunk named "ID3 ".
 */

const TE = new TextEncoder()

// ── ID3v2 field map (shared shape with MP3) ──────────────────────────────

const ID3_MAP_REV = {
  title: 'TIT2', artist: 'TPE1', album: 'TALB', albumartist: 'TPE2',
  composer: 'TCOM', genre: 'TCON', year: 'TDRC', track: 'TRCK',
  disc: 'TPOS', bpm: 'TBPM', key: 'TKEY', copyright: 'TCOP',
  isrc: 'TSRC', publisher: 'TPUB', software: 'TENC',
  comment: 'COMM', lyrics: 'USLT'
}

// ── Binary helpers (AIFF is big-endian) ──────────────────────────────────

function fourcc(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) }
function u32be(b, o) { return b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3] }
function wu32be(b, o, v) { b[o] = (v >>> 24) & 0xff; b[o + 1] = (v >>> 16) & 0xff; b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff }
function wSynchsafe(b, o, v) { b[o] = (v >>> 21) & 0x7f; b[o + 1] = (v >>> 14) & 0x7f; b[o + 2] = (v >>> 7) & 0x7f; b[o + 3] = v & 0x7f }

// ── ID3v2 builder ────────────────────────────────────────────────────────

function buildId3Frame(id, body) {
  let out = new Uint8Array(10 + body.length)
  out.set(TE.encode(id), 0)
  wSynchsafe(out, 4, body.length)
  out.set(body, 10)
  return out
}

function buildId3v2(meta) {
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
  if (!frames.length) return null
  let totalFrameSize = frames.reduce((n, f) => n + f.length, 0)
  let out = new Uint8Array(10 + totalFrameSize)
  out[0] = 0x49; out[1] = 0x44; out[2] = 0x33 // "ID3"
  out[3] = 4; out[4] = 0; out[5] = 0
  wSynchsafe(out, 6, totalFrameSize)
  let pos = 10
  for (let f of frames) { out.set(f, pos); pos += f.length }
  return out
}

/** Splice an ID3v2 chunk into AIFF/AIFC bytes. Returns new Uint8Array. */
export function writeMeta(bytes, { meta = {} } = {}) {
  if (bytes.length < 12 || fourcc(bytes, 0) !== 'FORM') return bytes
  let formType = fourcc(bytes, 8)
  if (formType !== 'AIFF' && formType !== 'AIFC') return bytes

  // keep every chunk except an existing ID3
  let keep = []
  let off = 12
  while (off + 8 <= bytes.length) {
    let id = fourcc(bytes, off), size = u32be(bytes, off + 4)
    let total = 8 + size + (size & 1)
    if (id !== 'ID3 ') keep.push(bytes.subarray(off, off + total))
    off += total
  }

  let tag = buildId3v2(meta)
  if (!tag) return bytes
  let pad = tag.length & 1
  let chunk = new Uint8Array(8 + tag.length + pad)
  chunk.set(TE.encode('ID3 '), 0)
  wu32be(chunk, 4, tag.length)
  chunk.set(tag, 8)

  let total = 4 // formType
  for (let c of keep) total += c.length
  total += chunk.length

  let out = new Uint8Array(8 + total)
  out.set(TE.encode('FORM'), 0)
  wu32be(out, 4, total)
  out.set(bytes.subarray(8, 12), 8) // AIFF / AIFC
  let pos = 12
  for (let c of keep) { out.set(c, pos); pos += c.length }
  out.set(chunk, pos)
  return out
}
