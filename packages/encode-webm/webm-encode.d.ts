export interface WebMEncodeOptions {
	sampleRate: number;
	channels?: number;
	bitrate?: number;
	application?: 'voip' | 'audio' | 'lowdelay';
}

export interface StreamEncoder {
	encode(channels: Float32Array[]): Uint8Array;
	flush(): Uint8Array;
	free(): void;
}

export default function webm(opts: WebMEncodeOptions): Promise<StreamEncoder>;
