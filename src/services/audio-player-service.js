import { parseBuffer } from 'music-metadata';
import logger from '../utils/logger.js';
import eventBus from '../utils/event-bus.js';

class AudioPlayerService {
    constructor(voxtaApiClient) {
        this.voxtaApiClient = voxtaApiClient;
        this.initialize();

        eventBus.on('voxtaMessage', this.handleVoxtaMessage.bind(this));
        eventBus.on('voiceChannelLeft', this.initialize.bind(this));
    }

    initialize() {
        // Audio buffers structure:
        // {
        //   messageId: {
        //     chunks: [],            // Array of reply chunks
        //     isComplete: false,     // Whether the message is complete
        //     sessionId: string,     // Session ID for the message
        //     isPlaying: false       // Whether currently playing
        //   }
        // }
        this.audioBuffers = {};
    }

    async checkAndSendPlaybackComplete(messageId) {
        const buffer = this.audioBuffers[messageId];
        if (!buffer) return;

        // If buffer is marked as complete and there are no pending audio chunks
        if (buffer.isComplete && buffer.chunks.length === 0) {
            await this.sendPlaybackComplete(messageId);
            delete this.audioBuffers[messageId];
            logger.debug(`Cleaned up buffer for message ${messageId}`);
        }
    }

    removePlaybackListeners() {
        eventBus.removeAllListeners('audioPlaybackComplete');
        eventBus.removeAllListeners('audioPlaybackError');
    }

    async playBuffer(messageId) {
        const messageBuffer = this.audioBuffers[messageId];
        if (!messageBuffer) {
            logger.debug(`No buffer found for message ${messageId}`);
            return;
        }

        if (messageBuffer.isPlaying) {
            logger.debug('Already playing, skipping');
            return;
        }

        const chunk = this.getNextValidChunk(messageBuffer);

        if (!chunk) {
            return;
        }

        messageBuffer.isPlaying = true;
        let promise = this.voxtaApiClient.getAudioResponse(chunk.audioUrl);

        while (promise) {
            const data = await promise;
            const metadata = await parseBuffer(data);

            eventBus.emit('speechPlaybackStart', {
                sessionId: chunk.sessionId,
                messageId: chunk.messageId,
                startIndex: chunk.startIndex,
                endIndex: chunk.endIndex,
                duration: metadata.format.duration
            });

            // Download next audio chunk while we play it
            const nextChunk = this.getNextValidChunk(messageBuffer);
            const nextPromise = nextChunk ? this.voxtaApiClient.getAudioResponse(nextChunk.audioUrl) : null;

            try {
                const playbackPromise = new Promise((resolve, reject) => {
                    const completeListener = () => {
                        this.removePlaybackListeners();
                        resolve();
                    };
                    const errorListener = (error) => {
                        this.removePlaybackListeners();
                        reject(error);
                    };
                    
                    eventBus.once('audioPlaybackComplete', completeListener);
                    eventBus.once('audioPlaybackError', errorListener);
                });

                eventBus.emit('playAudio', data);
                await playbackPromise;
            } catch (error) {
                logger.error('Error playing audio:', error);
                messageBuffer.isPlaying = false;
                return;
            }

            promise = nextPromise;
        }

        await this.checkAndSendPlaybackComplete(messageId);
        messageBuffer.isPlaying = false;

        // Dirty workaround: try to play the buffer again - just in case we missed some chunks
        this.playBuffer(messageId);
    }

    handleReplyGenerating(message) {
        const messageId = message.messageId;
        const sessionId = message.sessionId;
        logger.info(`Initializing buffer for message ${messageId}`);
        this.audioBuffers[messageId] = {
            chunks: [],
            isComplete: false,
            sessionId: sessionId,
            isPlaying: false
        };
    }

    async sendPlaybackComplete(messageId) {
        const buffer = this.audioBuffers[messageId];
        if (!buffer) return;

        eventBus.emit('speechPlaybackComplete', messageId);
    }

    async handleReplyChunk(message) {
        const messageId = message.messageId;
        logger.info(`Received chunk for message ${messageId}`);
        
        try {
            this.audioBuffers[messageId].chunks.push(message);
            this.playBuffer(messageId);
        } catch (error) {
            logger.error('Error getting audio stream:', error);
        }
    }

    async handleReplyEnd(message) {
        const messageId = message.messageId;
        logger.info(`Marking message ${messageId} as complete`);
        if (this.audioBuffers[messageId]) {
            this.audioBuffers[messageId].isComplete = true;
            await this.checkAndSendPlaybackComplete(messageId);
        }
    }

    handleVoxtaMessage(message) {
        switch (message.$type) {
            case 'replyGenerating':
                this.handleReplyGenerating(message);
                break;
            case 'replyChunk':
                this.handleReplyChunk(message);
                break;
            case 'replyEnd':
                this.handleReplyEnd(message);
                break;
            case 'speechRecognitionPartial':
                this.handleUserInterruption();
                break;
        }
    }

    getNextValidChunk(messageBuffer) {
        while (messageBuffer.chunks.length > 0) {
            const chunk = messageBuffer.chunks.shift();
            if (chunk?.audioUrl?.length > 0) {
                return chunk;
            }
        }
        return null;
    }

    async handleUserInterruption() {
        this.removePlaybackListeners();
        for (const messageId in this.audioBuffers) {
            const buffer = this.audioBuffers[messageId];
            buffer.chunks = [];
            await this.checkAndSendPlaybackComplete(messageId);
        }
    }
}

export default AudioPlayerService;