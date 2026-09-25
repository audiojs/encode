export type Mp4Codec = 'aac' | 'alac' | 'opus' | 'flac' | 'mp3' | 'pcm'

export interface Mp4Picture {
	mime: string
	data: Uint8Array
	type?: number
	description?: string
}

export interface Mp4Meta {
	title?: string
	artist?: string
	album?: string
	albumartist?: string
	composer?: string
	genre?: string
	year?: string | number
	track?: string | number
	disc?: string | number
	comment?: string
	lyrics?: string
	copyright?: string
	bpm?: string | number
	key?: string
	isrc?: string
	publisher?: string
	software?: string
	pictures?: Mp4Picture[]
}

export interface Mp4Chapter {
	time: number  // seconds
	title: string
}

export interface OpusConfig {
	preSkip: number
	outputGain?: number
	channelMappingFamily?: number
	channelMappingTable?: number[]
	streamCount?: number
	coupledStreamCount?: number
}

export interface PcmConfig {
	bits: 16 | 24 | 32 | 64
	float?: boolean
	be?: boolean
}

export interface Mp4Track {
	codec: Mp4Codec
	sampleRate: number
	channels: number
	/** One access unit per entry: AAC raw AU (no ADTS), ALAC frame, Opus packet, FLAC frame, MP3 frame, or PCM chunk (interleaved bytes) */
	samples: Uint8Array[]
	/** Per-AU duration in `timescale` units. A single number applies to every AU. Omit for the codec's natural default. */
	durations?: number | Uint32Array | number[]
	/** Sample-table timescale. Default: sampleRate (Opus always 48000). */
	timescale?: number
	/** aac: AudioSpecificConfig bytes. alac: 24-byte ALACSpecificConfig (+ optional trailing channel layout). opus: OpusConfig. flac: STREAMINFO (34 bytes) [+ further metadata blocks]. pcm: PcmConfig. mp3: unused. */
	config?: Uint8Array | OpusConfig | PcmConfig
	/** Encoder delay, in PCM samples — written as an edit-list media-time offset and (AAC) the iTunSMPB freeform tag. */
	priming?: number
	/** Trailing pad, in PCM samples — trims the edit list's presented duration. */
	padding?: number
	/** bits per second, written to esds/btrt when given */
	bitrate?: number
}

export interface MuxOptions {
	/** Default 'M4A ' for audio-only files. */
	brand?: 'M4A ' | 'isom' | 'mp42' | 'qt  '
	meta?: Mp4Meta
	chapters?: Mp4Chapter[]
	creationTime?: Date
}

/** Mux one pre-encoded audio track into a complete MP4/M4A file: ftyp + moov + mdat. */
export function mux(track: Mp4Track, opts?: MuxOptions): Uint8Array

/** Init segment of a fragmented file (ISO/IEC 14496-12 §8.8): ftyp + moov with the sample entry,
 *  empty sample tables and mvex/trex. `track` as for mux(), without `samples`. */
export function fragmentInit(track: Omit<Mp4Track, 'samples'>, opts?: MuxOptions): Uint8Array

/** One fragment: moof (mfhd `seq`, tfhd default-base-is-moof, tfdt `time`, trun) + mdat.
 *  `ticks` is its duration in the track timescale, to add to `time` for the next one. */
export function fragment(track: Omit<Mp4Track, 'samples'>, samples: Uint8Array[], seq: number, time: number): { bytes: Uint8Array, ticks: number }

/** Media time access units cover: [ticks, timescale]. */
export function unitsTime(track: Omit<Mp4Track, 'samples'>, samples: Uint8Array[]): [number, number]
