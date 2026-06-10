const DOWNLOADING_PERCENT = 0.75;
const EXTRACTING_PERCENT = 0.25;

const getProgressText = (obj) => {
	return `${obj.text || ''} ${obj.status || ''}`.toLowerCase();
};

const getRawPercent = (obj, layer) => {
	if (typeof obj.percent === 'number') {
		return obj.percent / 100;
	}
	if (typeof obj.current === 'number' && typeof obj.total === 'number' && obj.total > 0) {
		return obj.current / obj.total;
	}
	return layer.rawPercent || 0;
};

const hasMeasurableProgress = (obj) => {
	return typeof obj.percent === 'number' || (typeof obj.current === 'number' && typeof obj.total === 'number' && obj.total > 0);
};

const getWeightedPercent = (obj, layer) => {
	const progressText = getProgressText(obj);
	const raw = getRawPercent(obj, layer);

	if (progressText.includes('pull complete') || progressText.includes('already exists')) {
		return 1;
	}
	if (progressText.includes('download complete')) {
		return DOWNLOADING_PERCENT;
	}
	if (progressText.includes('extracting')) {
		return hasMeasurableProgress(obj) ? raw * EXTRACTING_PERCENT + DOWNLOADING_PERCENT : DOWNLOADING_PERCENT;
	}
	if (progressText.includes('downloading')) {
		return raw * DOWNLOADING_PERCENT;
	}
	return raw;
};

const isImageAlreadyDownloaded = (image) => {
	const progressText = getProgressText(image);
	return progressText.includes('pulled') || progressText.includes('up to date') || progressText.includes('already exists');
};

const completeImageLayers = (image) => {
	Object.values(image.layers || {}).forEach((layer) => {
		layer.lastPercentWeighted = 100;
		layer.percentWeighted = 100;
	});
};

const getImageProgress = (image) => {
	if (image.alreadyDownloaded) {
		return 100;
	}
	const layers = Object.values(image.layers || {});
	return layers.length ? layers.reduce((sum, layer) => { return sum + (layer.percentWeighted || 0); }, 0) / layers.length : 0;
};

const dockerPullProgressParser = () => {
	const alreadyDownloadedImages = new Set();
	const lastImageProgress = {};
	let buffer = '';
	let pullProgress = {};

	const parseLine = (line) => {
		if (!line.trim()) {
			return false;
		}

		try {
			const obj = JSON.parse(line);
			if (!obj.id) {
				return false;
			}

			if (!obj.parent_id) {
				pullProgress[obj.id] = pullProgress[obj.id] || { layers: {} };
				Object.assign(pullProgress[obj.id], obj);
				if (isImageAlreadyDownloaded(pullProgress[obj.id])) {
					completeImageLayers(pullProgress[obj.id]);
				}
			} else {
				const parent = (pullProgress[obj.parent_id] ||= { layers: {} });
				const layer = (parent.layers[obj.id] ||= {});
				Object.assign(layer, obj);
				if (typeof obj.current === 'number') {
					layer.current = obj.current;
				}
				if (typeof obj.total === 'number' && obj.total > 0) {
					layer.total = obj.total;
				}
				if (typeof obj.percent === 'number') {
					layer.percent = obj.percent;
				} else if (typeof layer.current === 'number' && typeof layer.total === 'number' && layer.total > 0) {
					layer.percent = (layer.current / layer.total) * 100;
				}

				layer.rawPercent = Math.max(layer.rawPercent || 0, getRawPercent(obj, layer));
				const weightedPercent = getWeightedPercent(obj, layer);
				layer.lastPercentWeighted = Math.max(layer.lastPercentWeighted || 0, Math.round(weightedPercent * 100));
				layer.percentWeighted = layer.lastPercentWeighted;
			}
			return true;
		} catch (error) {}
		return false;
	};

	return (chunk) => {
		buffer += chunk.toString('utf8');
		const lines = buffer.split('\n');
		buffer = lines.pop();

		let hasUpdate = false;
		lines.forEach((line) => {
			hasUpdate = parseLine(line) || hasUpdate;
		});
		if (buffer.trim()) {
			try {
				JSON.parse(buffer);
				hasUpdate = parseLine(buffer) || hasUpdate;
				buffer = '';
			} catch (error) {}
		}

		for (const [imageId, image] of Object.entries(pullProgress)) {
			const layers = Object.values(image.layers || {});
			if (!layers.length && isImageAlreadyDownloaded(image) && !alreadyDownloadedImages.has(imageId)) {
				alreadyDownloadedImages.add(imageId);
				image.alreadyDownloaded = true;
			}
		}

		for (const [imageId, image] of Object.entries(pullProgress)) {
			const rawProgress = getImageProgress(image);
			lastImageProgress[imageId] = Math.max(lastImageProgress[imageId] || 0, Math.round(rawProgress));
			image.percentWeighted = lastImageProgress[imageId];
		}

		if (hasUpdate) {
			return pullProgress;
		}
	};
};

export default dockerPullProgressParser;
