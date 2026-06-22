/**
 * Meta writers — re-export from codec packages.
 * @module encode-audio/meta
 *
 * import { wav, mp3, flac, aiff, ogg } from 'encode-audio/meta'
 * let out = wav(bytes, { meta, markers, regions })
 *
 * Opus bakes tags at encode time — pass `meta` to `encode.opus(...)` directly.
 */

export { writeMeta as wav } from '@audio/encode-wav/meta'
export { writeMeta as mp3 } from '@audio/encode-mp3/meta'
export { writeMeta as flac } from '@audio/encode-flac/meta'
export { writeMeta as aiff } from '@audio/encode-aiff/meta'
export { writeMeta as ogg } from '@audio/encode-ogg/meta'
