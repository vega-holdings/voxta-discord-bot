import logger from '../utils/logger.js';
import eventBus from '../utils/eventBus.js';

class AudioPlayerService {
    constructor() {
        eventBus.on('voxtaMessage', this.handleVoxtaMessage.bind(this));
        eventBus.on('cleanup', this.cleanup.bind(this));
    }

    handleVoxtaMessage(message) {
        logger.info('AudioPlayer received message:', message.$type);

        if (message.$type === 'replyChunk' && message.audioUrl) {
            logger.info('Audio URL:', message.audioUrl);
          //AI! prend l'instance de voxtaService dans le contructeur (n'oublie de pas la donner en paramètre dans index.js).
          //Et utilise cette instance pour fetch (fetchResource) l'audioUrl.
            fetch(message.audioUrl)
                .then(response => {
                    const contentLength = response.headers.get('content-length');
                    logger.info('Audio file size:', 
                        contentLength ? `${(contentLength / 1024).toFixed(2)} KB` : 'unknown');
                })
                .catch(error => logger.error('Failed to fetch audio file:', error));
        }
    }

    cleanup() {
        // Cleanup resources if needed
    }
}

export default AudioPlayerService;
