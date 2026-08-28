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

t('encoder is browser-only', async () => {
	let aac = (await import('./aac-encode.js')).default
	let err
	try { await aac({ sampleRate: 48000, channels: 2 }) } catch (e) { err = e }
	ok(err, 'throws without WebCodecs')
})
