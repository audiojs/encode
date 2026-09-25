export interface Mp3EncodeOptions {
	/** Emit bytes as they encode (metadata in the header); head() gives the final header. */
	stream?: boolean;
	/** With stream: ID3v2 tags (meta) and chapters lead the stream. */
	meta?: Record<string, any>;
	chapters?: { time: number; title?: string }[];
	sampleRate: number;
	bitrate?: number;
	quality?: number;
	channels?: number;
}

export interface StreamEncoder {
	encode(channels: Float32Array[]): Uint8Array;
	flush(): Uint8Array;
	free(): void;
	/** After flush: bytes to write over the start (final totals), or null when exact. */
	head?(): Uint8Array | null;
}

export default function mp3(opts: Mp3EncodeOptions): Promise<StreamEncoder>;
