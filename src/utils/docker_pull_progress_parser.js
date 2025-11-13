const DOWNLOADING_PERCENT = 0.75;
const EXTRACTING_PERCENT = 0.25;

const dockerPullProgressParser = () => {
	const alreadyDownloadedImages = new Set();
	let pullProgress = {};
	let lastTotalProgress = 0;

	return (chunk) => {
		const data = chunk.toString('utf8');
		data.split('\n').forEach((line) => {
			if (!line.trim()) {
				return;
			}

			try {
				const obj = JSON.parse(line);
				if (!obj.id) {
					return;
				}
				
				if (!obj.parent_id) {
					pullProgress[obj.id] = pullProgress[obj.id] || { layers: {} };
					Object.assign(pullProgress[obj.id], obj);
				} else {
					const parent = (pullProgress[obj.parent_id] ||= { layers: {} });
					const layer = (parent.layers[obj.id] ||= {});
					Object.assign(layer, obj);
					if (typeof obj.total === 'number' && obj.total > 0) {
						layer.current = obj.current ?? layer.current ?? 0;
						layer.total = obj.total ?? layer.total ?? 0;
						layer.percent = (layer.current / layer.total) * 100
					}

					const status = (obj.status || '').toLowerCase();
					const raw = (layer.percent || 0) / 100;
					let weightedPercent = 0;
					if (status.includes('downloading')) {
						weightedPercent = raw * DOWNLOADING_PERCENT;
					}
					if (status.includes('extracting')) {
						weightedPercent = raw * EXTRACTING_PERCENT + DOWNLOADING_PERCENT;
					} else if (status.includes('complete') || status.includes('done') || status.includes('exists')) {
						weightedPercent = 1;
					} else {
						weightedPercent = raw;
					}
					layer.lastPercentWeighted = Math.max(layer.lastPercentWeighted || 0, Math.round(weightedPercent * 100));
					layer.percentWeighted = layer.lastPercentWeighted;;
				}
			} catch (error) {}
		});

		for (const [imageId, image] of Object.entries(pullProgress)) {
			const layers = Object.values(image.layers || {});
			const hasProgress = layers.some((layer) => { return layer.weightedPercent > 0;});
			if (!hasProgress && !alreadyDownloadedImages.has(imageId)) {
				alreadyDownloadedImages.add(imageId);
				image.alreadyDownloaded = true;
			}
		}

		const imageProgressValues = Object.values(pullProgress).map((image) => {
			if (image.alreadyDownloaded) {
				return 100;
			}
			const layers = Object.values(image.layers || {});
			return layers.length ? layers.reduce((sum, layer) => { return sum + (layer.percentWeighted || 0); }, 0) / layers.length : 0;
		});

		const totalProgress = imageProgressValues.length ? imageProgressValues.reduce((sum, value) => { return sum + value; }, 0) / imageProgressValues.length : 0;
		if (totalProgress >= lastTotalProgress) {
			lastTotalProgress = totalProgress;
			return pullProgress;
		}
	};
};

module.exports = dockerPullProgressParser;
