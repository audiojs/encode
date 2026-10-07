// GSM 06.10 encode against SoX 14.4.2's libgsm: fixtures/lena-2s.wav (2 s of audio-lena at 8 kHz, 16-bit) and SoX's
// encode of it, fixtures/lena-2s.sox.gsm: the same bytes, every one, however the samples arrive.
import t, { is, ok } from 'tst'
import { readFileSync } from 'node:fs'
import gsm from './gsm-encode.js'

const fix = f => readFileSync(new URL('./fixtures/' + f, import.meta.url))
const wavData = buf => { let d = buf.indexOf('data'); return new Int16Array(buf.buffer.slice(buf.byteOffset + d + 8, buf.byteOffset + d + 8 + buf.readUInt32LE(d + 4))) }
const x = Float32Array.from(wavData(fix('lena-2s.wav')), v => v / 32768)
const cat = parts => { let r = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)), o = 0; for (let p of parts) { r.set(p, o); o += p.length } return r }

t('encode: the bytes SoX (libgsm) writes, at once and in chunks of any length', async () => {
	let sox = new Uint8Array(fix('lena-2s.sox.gsm'))
	let e = await gsm({ sampleRate: 8000 })
	is(cat([e.encode([x]), e.flush()]), sox, 'at once')
	e.free()
	let f = await gsm({ sampleRate: 8000 }), parts = []
	for (let o = 0, k = 1; o < x.length; o += k, k = k * 13 % 997 + 1) parts.push(f.encode(x.subarray(o, o + k)))
	parts.push(f.flush())
	f.free()
	is(cat(parts), sox, 'in chunks')
})

t('encode: a partial last frame zero-padded; 8 kHz mono only', async () => {
	let e = await gsm({ sampleRate: 8000 })
	is(e.encode([x.subarray(0, 200)]).length, 33, 'one frame filled')
	is(e.flush().length, 33, 'the rest, padded')
	is(e.flush().length, 0, 'nothing left')
	e.free()
	let threw = async o => { try { await gsm(o); return false } catch { return true } }
	ok(await threw({ sampleRate: 44100 }), 'not 44.1 kHz')
	ok(await threw({ sampleRate: 8000, channels: 2 }), 'not stereo')
})
