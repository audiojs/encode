import t, { is, ok } from 'tst'
import { parseAsc } from './aac-encode.js'

const hex = s => new Uint8Array(s.split(' ').map(x => parseInt(x, 16)))

t('bare AudioSpecificConfig (Chromium): LC, 48 kHz, stereo', () => {
	is(parseAsc(hex('11 90')), { profile: 2, freqIdx: 3, channels: 2 })
})

t('ES_Descriptor wrapping the ASC (WebKit): same values', () => {
	// 03 (ES_Descriptor) → 04 (DecoderConfigDescriptor, OTI 0x40) → 05 (DecoderSpecificInfo = 11 90) → 06 (SLConfig)
	is(parseAsc(hex('03 80 80 80 22 00 00 00 04 80 80 80 14 40 14 00 18 00 00 00 00 00 00 00 00 00 05 80 80 80 02 11 90 06 80 80 80 01 02')), { profile: 2, freqIdx: 3, channels: 2 })
})

t('44.1 kHz mono LC', () => {
	is(parseAsc(hex('12 08')), { profile: 2, freqIdx: 4, channels: 1 })
})

t('garbage yields null so configured values stay', () => {
	is(parseAsc(hex('00')), null)
	is(parseAsc(hex('ff ff')), null)
})

// Without WebCodecs (Node, Firefox): the FDK encoder (WebAssembly). ISO 14496-3 ADTS framing; the
// reported delay and frame length are FDK's own (aacEncInfo nDelay / frameLength).
const sine = (n, sr = 48000) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 440 * i / sr))

t('FDK where WebCodecs is missing: ADTS frames as it encodes, the rest on flush', async () => {
	let aac = (await import('./aac-encode.js')).default
	let enc = await aac({ sampleRate: 48000, channels: 2 })
	is([enc.priming, enc.frameLength], [2048, 1024], 'AAC-LC: 2048-sample delay, 1024-sample frames')
	let x = sine(48000), a = enc.encode([x, x]), b = enc.flush()
	ok(a.length > 0, 'frames before flush')
	let frames = 0
	for (let buf of [a, b]) for (let p = 0; p + 7 <= buf.length;) {
		ok(buf[p] === 0xFF && (buf[p + 1] & 0xF6) === 0xF0, 'ADTS sync at every frame')
		p += ((buf[p + 3] & 3) << 11) | (buf[p + 4] << 3) | (buf[p + 5] >> 5); frames++
	}
	ok(frames >= Math.ceil((48000 + 2048) / 1024), `${frames} frames cover the input and the delay`)
})

t('FDK profiles: HE-AAC doubles the frame (SBR), HE-AACv2 needs stereo; bad configs name themselves', async () => {
	let aac = (await import('./aac-encode.js')).default
	let he = await aac({ sampleRate: 44100, channels: 2, profile: 'he', bitrate: 48 })
	is(he.frameLength, 2048, 'HE-AAC: 2048-sample frames')
	he.free()
	let err = ''
	try { await aac({ sampleRate: 44100, channels: 1, profile: 'hev2', bitrate: 32 }) } catch (e) { err = e.message }
	ok(/FDK rejected/.test(err), 'mono HE-AACv2 rejected: ' + err)
	try { await aac({ sampleRate: 44100, profile: 'xx' }) } catch (e) { err = e.message }
	ok(/unknown profile/.test(err), 'unknown profile')
})
