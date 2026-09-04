const EVENT_TAG = {
	HELLO: 0x10,
	OPEN: 0x11,
	STATE: 0x12,
	EVT: 0x13,
	CALL: 0x14,
	REPLY: 0x15,
	ACTIVATE: 0x16,
	CLOSE: 0x17,
	CONT: 0x1F
};

const MAX_MESSAGE_SIZE = 64 * 1024;
const CONT_HEADER_SIZE = 9;
const CONT_SLICE_SIZE = MAX_MESSAGE_SIZE - CONT_HEADER_SIZE;
const MAX_CONTINUATION_PARTS = 256;

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

export {
	EVENT_TAG,
	MAX_MESSAGE_SIZE,
	CONT_SLICE_SIZE,
	MAX_CONTINUATION_PARTS,
	encodeEvent,
	decodeEvent,
	encodeContinuation
};
