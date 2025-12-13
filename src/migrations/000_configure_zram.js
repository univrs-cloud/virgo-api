const fs = require('fs');
const { execa } = require('execa');

const configureZram = async () => {
	console.log(`Starting zram configuration...`);
	try {
		console.log('Checking if zram-tools is installed...');
		try {
			await execa('dpkg', ['-s', 'zram-tools']);
			console.log(`zram configured. Skipping configuration.`);
			return;
		} catch (error) {
			console.log('zram-tools is not installed, proceeding with configuration...');
		}

		console.log('Creating configure-zram-size script...');
		const configureZramScript = `#!/bin/bash
# Detect RAM size and configure zram percentage

TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_RAM_GB=$((TOTAL_RAM_KB / 1000 / 1000))

if [ "$TOTAL_RAM_GB" -le 4 ]; then
	PERCENT=50
elif [ "$TOTAL_RAM_GB" -le 8 ]; then
    PERCENT=30
else
	PERCENT=15
fi

# Update zram configuration
sed -i "s/^PERCENT=.*/PERCENT=$PERCENT/" /etc/default/zramswap
sed -i "s/^#ALGO=.*/ALGO=zstd/" /etc/default/zramswap
sed -i "s/^ALGO=.*/ALGO=zstd/" /etc/default/zramswap

echo "Configured zram: \${PERCENT}% of RAM with zstd compression"
`;
		fs.writeFileSync('/usr/local/bin/configure-zram-size', configureZramScript);
		fs.chmodSync('/usr/local/bin/configure-zram-size', '755');
		console.log('configure-zram-size script created');

		console.log('Installing zram-tools...');
		await execa('apt-get', ['update']);
		await execa('apt-get', ['install', '-y', 'zram-tools']);
		console.log('zram-tools installed');

		console.log('Running configure-zram-size...');
		await execa('/usr/local/bin/configure-zram-size');
		console.log('Initial zram configuration applied');

		console.log('Enabling and starting zramswap.service...');
		await execa('systemctl', ['enable', '--now', 'zramswap.service']);
		await execa('systemctl', ['restart', 'zramswap.service']);
		console.log('zramswap.service enabled and started');

		if (fs.existsSync('/etc/dphys-swapfile')) {
			console.log('Configuring swap to 512MB...');
			let swapConfig = fs.readFileSync('/etc/dphys-swapfile', 'utf8');
			swapConfig = swapConfig.replace(/^CONF_SWAPSIZE=.*/gm, 'CONF_SWAPSIZE=512');
			swapConfig = swapConfig.replace(/^#CONF_SWAPSIZE=/gm, 'CONF_SWAPSIZE=');
			fs.writeFileSync('/etc/dphys-swapfile', swapConfig);
			console.log('/etc/dphys-swapfile updated to 512MB');

			console.log('Restarting dphys-swapfile.service...');
			try {
				await execa('systemctl', ['restart', 'dphys-swapfile.service']);
				console.log('dphys-swapfile.service restarted');
			} catch (error) {
				console.log('Note: dphys-swapfile.service restart failed (may not be running yet):', error.message);
			}
		}

		console.log('Current swap status:');
		const { stdout } = await execa('swapon', ['--show']);
		console.log(stdout);

		console.log(`zram configuration completed successfully!`);
	} catch (error) {
		console.log(`zram configuration failed:`, error);
	}
};

// Run if this file is executed directly
if (require.main === module) {
	configureZram();
}

module.exports = configureZram;
