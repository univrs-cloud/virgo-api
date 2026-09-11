const MIRROR_WIDTH = 2;
const SIZE_TOLERANCE = 0.01;
const PARITY = {
	raidz1: 1,
	raidz2: 2,
	raidz3: 3
};

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

/** The narrowest vdev of this type that divides the drives evenly. Narrow vdevs mean more of them,
 * which is both faster and more tolerant overall, so it is the one variant of each type offered. */
const getVdevWidth = (count, parity) => {
	for (let width = parity + 2; width <= count; width += 1) {
		if (count % width === 0) {
			return width;
		}
	}

	return null;
};

const getTopologies = (drives) => {
	const count = drives?.length || 0;
	if (count < MIRROR_WIDTH || !areSameSize(drives)) {
		return [];
	}

	const size = Math.min(...drives.map(getSize));
	const topologies = [];
	for (const [type, parity] of Object.entries(PARITY)) {
		const width = getVdevWidth(count, parity);
		if (width) {
			const vdevs = count / width;
			topologies.push({
				type,
				vdevs,
				width,
				parity,
				tolerance: parity,
				usableBytes: vdevs * (width - parity) * size
			});
		}
	}

	if (count % MIRROR_WIDTH === 0) {
		const vdevs = count / MIRROR_WIDTH;
		topologies.push({
			type: 'mirror',
			vdevs,
			width: MIRROR_WIDTH,
			parity: MIRROR_WIDTH - 1,
			tolerance: 1,
			usableBytes: vdevs * size
		});
	}

	return topologies;
};

const getTopology = (drives, type) => {
	return getTopologies(drives).find((topology) => { return topology.type === type; }) || null;
};

const getVdevArguments = (topology, paths) => {
	const args = [];
	for (let index = 0; index < paths.length; index += topology.width) {
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
