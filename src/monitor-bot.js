import logger from './utils/logger.js';
import VoxtaApiClient from './clients/voxta-api-client.js';
import HubWebSocketClient from './clients/hub-web-socket-client.js';
import VoxtaConnectionConfig from './config/voxta-connection-config.js';
import WSMessageService from './services/ws-message-service.js';
import eventBus from './utils/event-bus.js';
import CONFIG from './config/config.js';

class MonitorBot {
    constructor() {
        const voxtaConnectionConfig = new VoxtaConnectionConfig(CONFIG.voxta.baseUrl);
        this.voxtaApiClient = new VoxtaApiClient(voxtaConnectionConfig);
        this.hubWebSocketClient = new HubWebSocketClient(voxtaConnectionConfig);
        this.wsMessageService = new WSMessageService(this.hubWebSocketClient);
        this.sessionId = null;
        
        // Set up event listener without awaiting promises
        eventBus.on('voxtaMessage', (message) => {
            if (message.$type === 'chatStarting') {
                this.sessionId = message.sessionId;
                logger.info(`[✓] Chat starting with sessionId: ${this.sessionId}`);
            }
            
            // Log all messages without waiting
            logger.info(`[Voxta] ${message.$type}`);
            if (logger.level === 'debug') {
                logger.debug('Full message:', message);
            }
        });
    }

    async start() {
        try {
            logger.info('[🚀] Starting monitor...');
            
            await this.hubWebSocketClient.start();
            await this.wsMessageService.authenticate();

            const lastChatId = await this.voxtaApiClient.getLastChatId();
            if (lastChatId) {
                logger.info(`[→] Resuming chat: ${lastChatId}`);
                await this.wsMessageService.resumeChat(lastChatId);
            } else {
                logger.warn('[!] No existing chats found');
            }

            process.on('SIGINT', async () => {
                logger.info('[→] Shutting down...');
                await this.hubWebSocketClient.stop();
                process.exit(0);
            });

            // Keep alive without blocking event loop
            setInterval(() => {}, 1000);

        } catch (error) {
            logger.error('[❌] Fatal error:', error);
            throw error;
        }
    }
}

export { MonitorBot }; 