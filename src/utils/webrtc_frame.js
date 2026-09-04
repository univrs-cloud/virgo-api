const EVENT_TAG = {
	HELLO: 0x10,
	OPEN: 0x11,
	STATE: 0x12,
	EVT: 0x13,
	CALL: 0x14,
	REPLY: 0x15,
	CONT: 0x1F
};

const HTTP_TAG = {
	REQ: 0x01,
	RESP: 0x02,
	CHUNK: 0x03,
	END: 0x04,
	ERR: 0x05,
	ABORT: 0x06
};

const MAX_MESSAGE_SIZE = 64 * 1024;
const CONT_HEADER_SIZE = 9;
const CONT_SLICE_SIZE = MAX_MESSAGE_SIZE - CONT_HEADER_SIZE;

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

		return {
			tag,
			cid: buffer.readUInt32LE(1),
			part: buffer.readUInt16LE(5),
			total: buffer.readUInt16LE(7),
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

const encodeHttp = (tag, requestId, body) => {
	const header = Buffer.alloc(5);
	header[0] = tag;
	header.writeUInt32LE(requestId >>> 0, 1);
	if (body === undefined) {
		return header;
	}

	const json = Buffer.from(JSON.stringify(body), 'utf8');
	return Buffer.concat([header, json]);
};

const encodeHttpChunk = (requestId, seq, bytes) => {
	const header = Buffer.alloc(9);
	header[0] = HTTP_TAG.CHUNK;
	header.writeUInt32LE(requestId >>> 0, 1);
	header.writeUInt32LE(seq >>> 0, 5);
	return Buffer.concat([header, bytes]);
};

const decodeHttp = (buffer) => {
	if (!buffer || buffer.length < 5) {
		return null;
	}

	const tag = buffer[0];
	const requestId = buffer.readUInt32LE(1);
	if (tag === HTTP_TAG.CHUNK) {
		if (buffer.length < 9) {
			return null;
		}

		return { tag, requestId, seq: buffer.readUInt32LE(5), bytes: buffer.subarray(9) };
	}

	if (buffer.length === 5) {
		return { tag, requestId, body: {} };
	}

	try {
		return { tag, requestId, body: JSON.parse(buffer.subarray(5).toString('utf8')) };
	} catch (error) {
		return null;
	}
};

export {
	EVENT_TAG,
	HTTP_TAG,
	MAX_MESSAGE_SIZE,
	CONT_SLICE_SIZE,
	encodeEvent,
	decodeEvent,
	encodeContinuation,
	encodeHttp,
	encodeHttpChunk,
	decodeHttp
};
