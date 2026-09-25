/**
 * WAV RIFF metadata writer — INFO, bext, iXML, cue/adtl chunks.
 * @module @audio/encode-wav/meta
 */

const TE = new TextEncoder()

// ── Constants ───────────────────────────────────────────────────────────

const INFO_MAP_REV = {
  title: 'INAM', artist: 'IART', album: 'IPRD', genre: 'IGNR',
  year: 'ICRD', track: 'ITRK', comment: 'ICMT', copyright: 'ICOP',
  engineer: 'IENG', software: 'ISFT', isrc: 'ISRC', subject: 'ISBJ',
  keywords: 'IKEY', location: 'IARL'
}

// ── Binary helpers ──────────────────────────────────────────────────────

function u32le(b, o) { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000) }
function wu32le(b, o, v) { b[o] = v; b[o + 1] = v >>> 8; b[o + 2] = v >>> 16; b[o + 3] = v >>> 24 }
function wu16le(b, o, v) { b[o] = v; b[o + 1] = v >>> 8 }
function fourcc(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) }

// ── Chunk builders ──────────────────────────────────────────────────────

function buildChunk(id, body) {
  let pad = body.length & 1
  let out = new Uint8Array(8 + body.length + pad)
  out.set(TE.encode(id), 0)
  wu32le(out, 4, body.length)
  out.set(body, 8)
  return out
}

function buildBext(meta) {
  let b = meta.raw?.bext
  if (!b) return null
  let body = new Uint8Array(602)
  let put = (s, off, len) => { let e = TE.encode(s || ''); body.set(e.subarray(0, len), off) }
  put(b.description, 0, 256)
  put(b.originator, 256, 32)
  put(b.originatorReference, 288, 32)
  put(b.originationDate, 320, 10)
  put(b.originationTime, 330, 8)
  wu32le(body, 338, b.timeReferenceLow | 0)
  wu32le(body, 342, b.timeReferenceHigh | 0)
  wu16le(body, 346, b.version ?? 1)
  return buildChunk('bext', body)
}

function buildInfo(meta) {
  let parts = []
  for (let k in INFO_MAP_REV) {
    let v = meta[k]
    if (v == null || v === '') continue
    let s = TE.encode(String(v) + '\0')
    let pad = s.length & 1
    let buf = new Uint8Array(8 + s.length + pad)
    buf.set(TE.encode(INFO_MAP_REV[k]), 0)
    wu32le(buf, 4, s.length)
    buf.set(s, 8)
    parts.push(buf)
  }
  if (!parts.length) return null
  let size = 4 + parts.reduce((n, p) => n + p.length, 0)
  let body = new Uint8Array(size)
  body.set(TE.encode('INFO'), 0)
  let pos = 4
  for (let p of parts) { body.set(p, pos); pos += p.length }
  return buildChunk('LIST', body)
}

function buildCueAdtl(markers, regions) {
  let all = [...markers.map(m => ({ sample: m.sample, label: m.label, duration: 0 })),
    ...regions.map(r => ({ sample: r.sample, label: r.label, duration: r.length }))]
  if (!all.length) return {}
  let cueBody = new Uint8Array(4 + all.length * 24)
  wu32le(cueBody, 0, all.length)
  for (let i = 0; i < all.length; i++) {
    let o = 4 + i * 24, it = all[i]
    wu32le(cueBody, o, i + 1)
    wu32le(cueBody, o + 4, i)
    cueBody.set(TE.encode('data'), o + 8)
    wu32le(cueBody, o + 12, 0)
    wu32le(cueBody, o + 16, 0)
    wu32le(cueBody, o + 20, it.sample)
  }
  let cueChunk = buildChunk('cue ', cueBody)

  let labelParts = []
  for (let i = 0; i < all.length; i++) {
    let it = all[i]
    let lblBytes = TE.encode((it.label || '') + '\0')
    if (it.duration > 0) {
      let body = new Uint8Array(20 + lblBytes.length)
      wu32le(body, 0, i + 1)
      wu32le(body, 4, it.duration)
      body.set(TE.encode('rgn '), 8)
      body.set(lblBytes, 20)
      labelParts.push(buildChunk('ltxt', body))
    } else {
      let body = new Uint8Array(4 + lblBytes.length)
      wu32le(body, 0, i + 1)
      body.set(lblBytes, 4)
      labelParts.push(buildChunk('labl', body))
    }
  }
  let adtlSize = 4 + labelParts.reduce((n, p) => n + p.length, 0)
  let adtlBody = new Uint8Array(adtlSize)
  adtlBody.set(TE.encode('adtl'), 0)
  let pos = 4
  for (let p of labelParts) { adtlBody.set(p, pos); pos += p.length }
  return { cue: cueChunk, adtl: buildChunk('LIST', adtlBody) }
}

/** Splice meta chunks into an encoded WAV. Returns new Uint8Array. */
/** Metadata chunks (bext, iXML, LIST/INFO, cue + LIST/adtl), in write order. */
export function metaChunks({ meta = {}, markers = [], regions = [] } = {}) {
  let extras = []
  let bext = buildBext(meta)
  if (bext) extras.push(bext)
  let iXML = meta.raw?.iXML
  if (iXML) extras.push(buildChunk('iXML', TE.encode(iXML)))
  let info = buildInfo(meta)
  if (info) extras.push(info)
  let { cue, adtl } = buildCueAdtl(markers, regions)
  if (cue) extras.push(cue)
  if (adtl) extras.push(adtl)
  return extras
}

export function writeMeta(bytes, { meta = {}, markers = [], regions = [] } = {}) {
  if (bytes.length < 12 || fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WAVE') return bytes

  let keep = []
  let off = 12
  while (off + 8 <= bytes.length) {
    let id = fourcc(bytes, off), size = u32le(bytes, off + 4)
    let pad = size & 1
    let total = 8 + size + pad
    let drop = id === 'bext' || id === 'iXML' || id === 'cue ' ||
      (id === 'LIST' && size >= 4 && (fourcc(bytes, off + 8) === 'INFO' || fourcc(bytes, off + 8) === 'adtl'))
    if (!drop) keep.push(bytes.subarray(off, off + total))
    off += total
  }

  let extras = metaChunks({ meta, markers, regions })

  let total = 4  // "WAVE"
  for (let c of keep) total += c.length
  for (let e of extras) total += e.length

  let out = new Uint8Array(8 + total)
  out.set(TE.encode('RIFF'), 0)
  wu32le(out, 4, total)
  out.set(TE.encode('WAVE'), 8)
  let pos = 12
  let data = null
  for (let c of keep) {
    if (fourcc(c, 0) === 'data') { data = c; continue }
    out.set(c, pos); pos += c.length
  }
  for (let e of extras) { out.set(e, pos); pos += e.length }
  if (data) { out.set(data, pos); pos += data.length }
  return out.subarray(0, pos)
}
