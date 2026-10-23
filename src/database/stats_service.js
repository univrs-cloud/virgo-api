import { Op } from 'sequelize';
import * as database from './stats.js';
import Sample from './models/Sample.js';

let synced = false;

const ensureReady = async () => {
	if (!await database.ensureOpen()) {
		return false;
	}

	if (!synced) {
		await Sample.sync({ force: false });
		synced = true;
	}
	return true;
};

class StatsService {
	static async getSamples(since) {
		try {
			if (!await ensureReady()) {
				return [];
			}

			return await Sample.findAll({
				where: { time: { [Op.gt]: since } },
				order: [['time', 'ASC']],
				raw: true
			});
		} catch (error) {
			console.error(`Error reading stats samples from database:`, error);
			return [];
		}
	}

	static async saveSamples(samples, before) {
		try {
			if (!await ensureReady()) {
				return false;
			}

			await database.sequelize.transaction(async (transaction) => {
				await Sample.bulkCreate(samples, { ignoreDuplicates: true, transaction });
				await Sample.destroy({ where: { time: { [Op.lte]: before } }, transaction });
			});
			return true;
		} catch (error) {
			console.error(`Error writing stats samples to database:`, error);
			return false;
		}
	}
}

export default StatsService;
