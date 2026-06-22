export interface AACEncodeOptions {
	sampleRate: number;
	channels?: number;
	bitrate?: number;
}

export interface StreamEncoder {
	encode(channels: Float32Array[]): Promise<Uint8Array>;
	flush(): Promise<Uint8Array>;
	free(): void;
}

export default function aac(opts: AACEncodeOptions): Promise<StreamEncoder>;
