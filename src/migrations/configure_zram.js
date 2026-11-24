import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execa } from 'execa';
import { createLog } from '../utils/log.js';

const log = createLog('migrations');

const isMainModule = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

const configureZram = async () => {
	log.info(`Starting zram configuration...`);
	try {
		log.info('Checking if zram-tools is installed...');
		try {
			await execa('dpkg', ['-s', 'zram-tools']);
			log.info(`zram-tools is configured. Skipping configuration.`);
			return;
		} catch (error) {
			log.info('zram-tools is not installed, proceeding with configuration...');
		}

		log.info('Creating configure-zram-size script...');
		const configureZramScript = `#!/bin/bash
# Detect RAM size and configure zram percentage

TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_RAM_GB=$((TOTAL_RAM_KB / 1024 / 1024))

if [ "$TOTAL_RAM_GB" -le 4 ]; then
	PERCENT=50
elif [ "$TOTAL_RAM_GB" -le 8 ]; then
    PERCENT=30
else
	PERCENT=15
fi

# Update zram configuration
sed -i "s/^#PERCENT=.*/PERCENT=$PERCENT/" /etc/default/zramswap
sed -i "s/^PERCENT=.*/PERCENT=$PERCENT/" /etc/default/zramswap
sed -i "s/^#ALGO=.*/ALGO=zstd/" /etc/default/zramswap
sed -i "s/^ALGO=.*/ALGO=zstd/" /etc/default/zramswap

echo "Configured zram: \${PERCENT}% of RAM with zstd compression"
`;
		fs.writeFileSync('/usr/local/bin/configure-zram-size', configureZramScript);
		fs.chmodSync('/usr/local/bin/configure-zram-size', '755');
		log.info('configure-zram-size script created');

		log.info('Installing zram-tools...');
		await execa('apt', ['update']);
		await execa('apt', ['install', '-y', 'zram-tools']);
		log.info('zram-tools installed');

		log.info('Running configure-zram-size...');
		await execa('/usr/local/bin/configure-zram-size');
		log.info('Initial zram configuration applied');

		log.info('Enabling and starting zramswap.service...');
		await execa('systemctl', ['enable', '--now', 'zramswap.service']);
		await execa('systemctl', ['restart', 'zramswap.service']);
		log.info('zramswap.service enabled and started');

		if (fs.existsSync('/etc/dphys-swapfile')) {
			log.info('Configuring swap to 512MB...');
			let swapConfig = fs.readFileSync('/etc/dphys-swapfile', 'utf8');
			swapConfig = swapConfig.replace(/^CONF_SWAPSIZE=.*/gm, 'CONF_SWAPSIZE=512');
			swapConfig = swapConfig.replace(/^#CONF_SWAPSIZE=/gm, 'CONF_SWAPSIZE=');
			fs.writeFileSync('/etc/dphys-swapfile', swapConfig);
			log.info('/etc/dphys-swapfile updated to 512MB');

			log.info('Restarting dphys-swapfile.service...');
			try {
				await execa('systemctl', ['restart', 'dphys-swapfile.service']);
				log.info('dphys-swapfile.service restarted');
			} catch (error) {
				log.info('Note: dphys-swapfile.service restart failed (may not be running yet):', error.message);
			}
		}

		log.info('Current swap status:');
		const { stdout } = await execa('swapon', ['--show']);
		log.info(stdout);

		log.info(`zram configuration completed successfully!`);
	} catch (error) {
		log.info(`zram configuration failed:`, error);
	}
};

if (isMainModule) {
	configureZram();
}

export default configureZram;
