type AudioInput = Float32Array[] | Float32Array | { numberOfChannels: number; getChannelData(i: number): Float32Array };

export interface Meta {
	title?: string; artist?: string; album?: string; albumartist?: string;
	composer?: string; genre?: string; year?: string | number; track?: string | number;
	disc?: string | number; bpm?: string | number; key?: string; comment?: string;
	copyright?: string; isrc?: string; publisher?: string; software?: string; lyrics?: string;
	pictures?: { mime?: string; description?: string; type?: number; data: Uint8Array }[];
	[key: string]: any;
}

export interface Marker { sample: number; label?: string; }
export interface Region { sample: number; length: number; label?: string; }

export interface EncodeOptions {
	/** Output sample rate (required). */
	sampleRate: number;
	/** Output channel count. */
	channels?: number;
	/** Target bitrate in kbps (lossy: mp3, opus, webm, aac). */
	bitrate?: number;
	/** Quality 0-10 (VBR, format-specific: ogg, mp3). */
	quality?: number;
	/** Bit depth: 16|24|32 for wav, 16|24 for aiff/flac, 16|32 for caf. */
	bitDepth?: number;
	/** FLAC compression level 0-8. */
	compression?: number;
	/** Opus/WebM application: 'audio', 'voip', 'lowdelay'. */
	application?: string;
	/** Tags. Baked in for opus; for wav/mp3/flac/aiff/ogg also available via encode-audio/meta. */
	meta?: Meta;
	/** Cue markers (wav). */
	markers?: Marker[];
	/** Labeled regions (wav). */
	regions?: Region[];
	[key: string]: any;
}

export interface StreamEncoder {
	/** Encode a chunk of audio. */
	(channelData: AudioInput): Promise<Uint8Array>;
	/** Flush remaining data, finalize, and free resources. */
	(): Promise<Uint8Array>;
	/** Flush without freeing. */
	flush(): Promise<Uint8Array>;
	/** Free resources without flushing. */
	free(): void;
}

export interface FormatEncoder {
	/** Whole-file encode. */
	(channelData: AudioInput, opts: EncodeOptions): Promise<Uint8Array>;
	/** Chunked encode from async iterable. */
	(source: AsyncIterable<AudioInput>, opts: EncodeOptions): AsyncGenerator<Uint8Array>;
	/** Create streaming encoder. */
	(opts: EncodeOptions): Promise<StreamEncoder>;
}

declare const encode: {
	/** Whole-file encode. */
	(format: string, channelData: AudioInput, opts: EncodeOptions): Promise<Uint8Array>;
	/** Chunked encode from async iterable. */
	(format: string, source: AsyncIterable<AudioInput>, opts: EncodeOptions): AsyncGenerator<Uint8Array>;
	/** Create streaming encoder. */
	(format: string, opts: EncodeOptions): Promise<StreamEncoder>;

	wav: FormatEncoder;
	aiff: FormatEncoder;
	caf: FormatEncoder;
	mp3: FormatEncoder;
	ogg: FormatEncoder;
	flac: FormatEncoder;
	opus: FormatEncoder;
	/** WebM (Opus). */
	webm: FormatEncoder;
	/** AAC (ADTS) — browser-only via WebCodecs; throws in Node. */
	aac: FormatEncoder;
	/** QOA (Quite OK Audio). */
	qoa: FormatEncoder;
	/** Supported format names. */
	formats: string[];
	/** Format → MIME type. */
	mime: Record<string, string>;
	[format: string]: any;
};

export default encode;

/** Supported format names. */
export const formats: string[];
/** Format → MIME type map. */
export const mime: Record<string, string>;

/** Chunked encode from async iterable. */
export function encodeChunked(
	source: AsyncIterable<AudioInput>,
	format: string,
	opts: EncodeOptions
): AsyncGenerator<Uint8Array>;

/** Wrap codec callbacks into a StreamEncoder with lifecycle management. */
export function streamEncoder(
	onEncode: (channels: Float32Array[]) => Uint8Array | Promise<Uint8Array>,
	onFlush?: (() => Uint8Array | Promise<Uint8Array>) | null,
	onFree?: (() => void) | null
): StreamEncoder;
