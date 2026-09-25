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
	/** Chapters (mp3: ID3 CHAP/CTOC; m4a/mp4: chpl). */
	chapters?: { time: number; title?: string }[];
	/** AAC profile: 'lc' (default), 'he' (HE-AAC, SBR), 'hev2' (HE-AACv2, SBR + PS, stereo). */
	profile?: 'lc' | 'he' | 'hev2';
	/** Emit bytes as they encode, metadata in the header, memory flat however long the stream:
	 *  totals the header can't know yet read "unknown" (WAV/AIFF 0xFFFFFFFF, CAF -1, QOA 0,
	 *  FLAC STREAMINFO 0) until `head()`; m4a/mp4 become fragmented. */
	stream?: boolean;
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
	/** After the end: bytes to write over the start of the output (the header with its final
	 *  totals, RF64 for WAV past 4 GB), or null when the output is already exact. */
	head(): Uint8Array | null;
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
	/** AAC (ADTS): WebCodecs where the browser has it, else the FDK encoder (WebAssembly). */
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
