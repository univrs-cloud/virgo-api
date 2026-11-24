const MAX_LENGTH = 2000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

const describeCause = (error) => {
	const cause = error?.cause;
	if (!cause) {
		return '';
	}

	const detail = String(cause.stderr || cause.shortMessage || cause.message || cause).trim();
	return (detail ? ` (${detail})` : '');
};

const describe = (value, withStack) => {
	if (value instanceof Error) {
		return `${(withStack && value.stack ? value.stack : value.message)}${describeCause(value)}`;
	}

	if (value !== null && typeof value === 'object') {
		try {
			return JSON.stringify(value);
		} catch (error) {
			return String(value);
		}
	}

	return String(value);
};

const format = (label, values, withStack) => {
	const text = values.map((value) => { return describe(value, withStack); }).join(' ');
	return `[${label}] ${text}`.replace(CONTROL_CHARACTERS, ' ').replace(/ {2,}/g, ' ').slice(0, MAX_LENGTH);
};

const createLog = (label) => {
	return {
		info: (...values) => { console.log(format(label, values, false)); },
		warn: (...values) => { console.warn(format(label, values, false)); },
		error: (...values) => { console.error(format(label, values, true)); }
	};
};

export {
	createLog
};
