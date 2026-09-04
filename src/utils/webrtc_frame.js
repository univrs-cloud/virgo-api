const EVENT_TAG = {
	HELLO: 0x10,
	OPEN: 0x11,
	STATE: 0x12,
	EVT: 0x13,
	CALL: 0x14,
	REPLY: 0x15,
	ACTIVATE: 0x16,
	CLOSE: 0x17,
	PING: 0x18,
	PONG: 0x19,
	CONT: 0x1F
};

const ASSET_TAG = {
	REQ: 0x20,
	RES: 0x21,
	CHUNK: 0x22,
	END: 0x23,
	ERR: 0x24,
	ABORT: 0x25,
	CREDIT: 0x26
};

const MAX_MESSAGE_SIZE = 64 * 1024;
const CONT_HEADER_SIZE = 9;
const CONT_SLICE_SIZE = MAX_MESSAGE_SIZE - CONT_HEADER_SIZE;
const MAX_CONTINUATION_PARTS = 256;
const ASSET_HEADER_SIZE = 5;
const ASSET_CHUNK_HEADER_SIZE = 9;
const ASSET_CHUNK_SIZE = MAX_MESSAGE_SIZE - ASSET_CHUNK_HEADER_SIZE;
const ASSET_TAGS = new Set(Object.values(ASSET_TAG));

const encodeEvent = (tag, body) => {
	const json = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
	return Buffer.concat([Buffer.from([tag]), json]);
};

const decodeEvent = (buffer) => {
	if (!buffer?.length) {
		return null;
	}

	const tag = buffer[0];
	if (tag === EVENT_TAG.CONT) {
		if (buffer.length < CONT_HEADER_SIZE) {
			return null;
		}

		const part = buffer.readUInt16LE(5);
		const total = buffer.readUInt16LE(7);
		if (!total || total > MAX_CONTINUATION_PARTS || part >= total) {
			return null;
		}

		return {
			tag,
			cid: buffer.readUInt32LE(1),
			part,
			total,
			slice: buffer.subarray(CONT_HEADER_SIZE)
		};
	}

	try {
		return { tag, body: JSON.parse(buffer.subarray(1).toString('utf8')) };
	} catch (error) {
		return null;
	}
};

const encodeContinuation = (cid, payload) => {
	const total = Math.max(1, Math.ceil(payload.length / CONT_SLICE_SIZE));
	const frames = [];
	for (let part = 0; part < total; part += 1) {
		const header = Buffer.alloc(CONT_HEADER_SIZE);
		header[0] = EVENT_TAG.CONT;
		header.writeUInt32LE(cid, 1);
		header.writeUInt16LE(part, 5);
		header.writeUInt16LE(total, 7);
		frames.push(Buffer.concat([header, payload.subarray(part * CONT_SLICE_SIZE, (part + 1) * CONT_SLICE_SIZE)]));
	}

	return frames;
};

const encodeAssetControl = (tag, requestId, body) => {
	const header = Buffer.alloc(ASSET_HEADER_SIZE);
	header[0] = tag;
	header.writeUInt32LE(requestId, 1);
	return Buffer.concat([header, Buffer.from(JSON.stringify(body ?? {}), 'utf8')]);
};

const encodeAssetChunk = (requestId, seq, bytes) => {
	const header = Buffer.alloc(ASSET_CHUNK_HEADER_SIZE);
	header[0] = ASSET_TAG.CHUNK;
	header.writeUInt32LE(requestId, 1);
	header.writeUInt32LE(seq, 5);
	return Buffer.concat([header, bytes]);
};

const decodeAssetFrame = (buffer) => {
	if (!buffer?.length || !ASSET_TAGS.has(buffer[0])) {
		return null;
	}

	const tag = buffer[0];
	if (tag === ASSET_TAG.CHUNK) {
		if (buffer.length < ASSET_CHUNK_HEADER_SIZE) {
			return null;
		}
		return {
			tag,
			requestId: buffer.readUInt32LE(1),
			seq: buffer.readUInt32LE(5),
			bytes: buffer.subarray(ASSET_CHUNK_HEADER_SIZE)
		};
	}

	if (buffer.length < ASSET_HEADER_SIZE) {
		return null;
	}
	try {
		const json = buffer.subarray(ASSET_HEADER_SIZE).toString('utf8');
		return {
			tag,
			requestId: buffer.readUInt32LE(1),
			body: json ? JSON.parse(json) : {}
		};
	} catch (error) {
		return null;
	}
};

export {
	EVENT_TAG,
	ASSET_TAG,
	ASSET_CHUNK_SIZE,
	MAX_MESSAGE_SIZE,
	CONT_SLICE_SIZE,
	MAX_CONTINUATION_PARTS,
	encodeEvent,
	decodeEvent,
	encodeContinuation,
	encodeAssetControl,
	encodeAssetChunk,
	decodeAssetFrame
};
