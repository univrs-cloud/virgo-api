const MIRROR_WIDTH = 2;
const SIZE_TOLERANCE = 0.1;
const MAX_UNUSED = 1;
const PARITY = {
	raidz1: 1,
	raidz2: 2,
	raidz3: 3
};
const RECOMMENDED_TYPES = ['raidz2', 'raidz1', 'mirror'];
const MEDIA = ['hdd', 'ssd', 'nvme'];

const getSize = (drive) => {
	const size = Number(drive?.size);
	return (Number.isFinite(size) && size > 0 ? size : null);
};

const areSameSize = (drives) => {
	const sizes = drives.map(getSize);
	if (sizes.length === 0 || sizes.some((size) => { return size === null; })) {
		return false;
	}

	const largest = Math.max(...sizes);
	return (largest - Math.min(...sizes)) / largest <= SIZE_TOLERANCE;
};

const getPerformanceLayout = (count, parity) => {
	let layout = null;
	for (let width = parity + 2; width <= Math.floor(count / 2); width += 1) {
		const unused = count % width;
		if (unused <= MAX_UNUSED && (!layout || unused < layout.unused)) {
			layout = { width, unused };
		}
	}

	return layout;
};

const createTopology = ({ media, drives, type, variant, width, parity, unused, count, size }) => {
	const vdevs = Math.floor((count - unused) / width);
	const dataDrives = (type === 'mirror' ? 1 : width - parity);
	return {
		media,
		drives,
		type,
		variant,
		vdevs,
		width,
		parity,
		tolerance: parity,
		unused,
		usableBytes: vdevs * dataDrives * size,
		recommended: false
	};
};

const getMediaTopologies = (media, poolDrives) => {
	const count = poolDrives.length;
	if (count < MIRROR_WIDTH || !areSameSize(poolDrives)) {
		return [];
	}

	const drives = poolDrives.map((drive) => { return drive.id; });
	const size = Math.min(...poolDrives.map(getSize));
	const topologies = [];
	if (count === MIRROR_WIDTH) {
		topologies.push(createTopology({ media, drives, type: 'mirror', variant: null, width: MIRROR_WIDTH, parity: MIRROR_WIDTH - 1, unused: 0, count, size }));
	}
	for (const [type, parity] of Object.entries(PARITY)) {
		if (count < parity + 2) {
			continue;
		}

		const performance = getPerformanceLayout(count, parity);
		if (performance) {
			topologies.push(createTopology({ media, drives, type, variant: 'performance', width: performance.width, parity, unused: performance.unused, count, size }));
		}
		topologies.push(createTopology({ media, drives, type, variant: (performance ? 'capacity' : null), width: count, parity, unused: 0, count, size }));
	}

	return topologies;
};

const getRecommended = (topologies) => {
	return RECOMMENDED_TYPES
		.map((type) => { return topologies.find((topology) => { return topology.type === type && topology.variant !== 'performance'; }); })
		.find(Boolean);
};

const getTopologies = (drives) => {
	const poolDrives = (drives || []).filter((drive) => { return !drive?.system; });
	const groups = MEDIA.map((media) => {
		return getMediaTopologies(media, poolDrives.filter((drive) => { return drive?.type === media; }));
	});
	let recommended = null;
	for (const topologies of groups) {
		const candidate = getRecommended(topologies);
		if (candidate && (!recommended || candidate.usableBytes >= recommended.usableBytes)) {
			recommended = candidate;
		}
	}
	if (recommended) {
		recommended.recommended = true;
	}

	return groups.flat();
};

const getTopology = (drives, media, type, width) => {
	return getTopologies(drives).find((topology) => {
		if (topology.media !== media || topology.type !== type) {
			return false;
		}

		return (width === undefined ? topology.variant !== 'performance' : topology.width === Number(width));
	}) || null;
};

const getVdevArguments = (topology, paths) => {
	const args = [];
	for (let index = 0; index < topology.vdevs * topology.width; index += topology.width) {
		args.push(topology.type, ...paths.slice(index, index + topology.width));
	}

	return args;
};

export {
	MIRROR_WIDTH,
	areSameSize,
	getTopologies,
	getTopology,
	getVdevArguments
};
