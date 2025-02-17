import { Bot } from './bot.js';
import { DeviceBot } from './device-bot.js';
import { MonitorBot } from './monitor-bot.js';
import logger from './utils/logger.js';
import CONFIG from './config/config.js';
import dotenv from 'dotenv';
import eventBus from './utils/event-bus.js';

// Load environment variables
dotenv.config();

async function main() {
    const botMode = process.env.BOT_MODE?.toLowerCase() || 'discord';
    logger.info(`Starting bot in ${botMode} mode`);

    try {
        let bot;
        switch (botMode) {
            case 'monitor':
                logger.info('Initializing monitor bot...');
                bot = new MonitorBot();
                break;
            case 'device':
                bot = new DeviceBot();
                break;
            case 'discord':
                bot = new Bot(CONFIG.discord.token);
                break;
            default:
                throw new Error(`Unknown bot mode: ${botMode}`);
        }
        await bot.start();
    } catch (error) {
        logger.error('Fatal error:', error);
        process.exit(1);
    }
}

main();

// Handle graceful shutdown
process.on('SIGINT', async () => {
    logger.info("\nClosing connections...");
    await eventBus.emit('shutdown');
    await bot.destroy();
    process.exit(0);
});

// Handle other termination signals
process.on('SIGTERM', async () => {
    logger.info("\nReceived SIGTERM signal...");
    await eventBus.emit('shutdown');
    await bot.destroy();
    process.exit(0);
});