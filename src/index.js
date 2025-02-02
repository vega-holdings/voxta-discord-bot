import { Bot } from './bot.js';
import { DeviceBot } from './device-bot.js';
import CONFIG from './config/config.js';
import logger from './utils/logger.js';
import eventBus from './utils/event-bus.js';

const audioMode = CONFIG.audio.mode;
let bot;

if (audioMode === 'discord') {
    bot = new Bot(CONFIG.discord.token);
} else if (audioMode === 'device') {
    bot = new DeviceBot(CONFIG.device.token);
} else {
    logger.error('Invalid AUDIO_MODE in .env. Please set it to "discord" or "device".');
    process.exit(1);
}

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

bot.start();