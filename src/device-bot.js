import http from 'http';
import { WebSocketServer } from 'ws';
import logger from './utils/logger.js';
import eventBus from './utils/event-bus.js';
import prism from 'prism-media';
import VoxtaApiClient from './clients/voxta-api-client.js';
import HubWebSocketClient from './clients/hub-web-socket-client.js';
import AudioWebSocketClient from './clients/audio-websocket-client.js';
import WSMessageService from './services/ws-message-service.js';
import VoxtaConnectionConfig from './config/voxta-connection-config.js';
import CONFIG from './config/config.js';

/**
 * DeviceBot
 * ------------
 * For BOT_MODE=device:
 * 1. Starts a local WebSocket server on port 3001.
 * 2. Expects **raw PCM** (16 kHz, mono) from the device.
 * 3. Forwards PCM to Voxta once "recordingStatus" is true.
 * 4. When Voxta sends TTS as MP3, we decode to 16 kHz PCM and send that raw PCM back to the device.
 */
export class DeviceBot {
    constructor() {
        const voxtaConnectionConfig = new VoxtaConnectionConfig(CONFIG.voxta.baseUrl);

        // Voxta clients
        this.voxtaApiClient = new VoxtaApiClient(voxtaConnectionConfig);
        this.hubWebSocketClient = new HubWebSocketClient(voxtaConnectionConfig);
        this.audioWebSocketClient = new AudioWebSocketClient(voxtaConnectionConfig);
        this.wsMessageService = new WSMessageService(this.hubWebSocketClient);

        // WebSocket references
        this.httpServer = null;
        this.wss = null;
        this.deviceSocket = null;

        // Session logic
        this.sessionId = null;
        this.isRecording = false;
        this.lastSentText = null;
        this.lastSentTimestamp = 0;
        // Used to accumulate partial STT text
        this.currentPartialText = '';
        
        // Add audio buffer tracking
        this.audioBuffers = {};
        this.currentMessageId = null;
        
        // Bind event handlers
        eventBus.on('voxtaMessage', this.handleVoxtaMessage.bind(this));
        this.setupEventListeners();
    }

    async start() {
        logger.info('Device bot initialized!');
        
        await this.setupWebSocketServer();
        
        await this.hubWebSocketClient.start();
        await this.wsMessageService.authenticate();
        
        const lastChatId = await this.voxtaApiClient.getLastChatId();
        if (lastChatId) {
            await this.wsMessageService.resumeChat(lastChatId);
        }
    }

    /**
     * Creates the local WebSocket server on port 3001.
     * Accepts only one device connection at a time for simplicity.
     */
    setupWebSocketServer() {
        this.httpServer = http.createServer();
        this.wss = new WebSocketServer({ 
            server: this.httpServer,
            // Add WebSocket server options for faster handling
            clientTracking: true,
            perMessageDeflate: false, // Disable compression for faster processing
        });

        this.wss.on('connection', (ws, req) => {
            logger.info(`[DEBUG] New WebSocket connection from ${req.socket.remoteAddress}`);
            
            // Set WebSocket options for better performance
            ws.setMaxListeners(20);
            ws.binaryType = 'nodebuffer';
            
            if (this.deviceSocket) {
                logger.info('[DEBUG] Closing existing device connection');
                // Force close the existing connection
                this.deviceSocket.terminate();
                this.deviceSocket = null;
            }

            this.deviceSocket = ws;

            // Add ping/pong for connection health monitoring
            ws.isAlive = true;
            ws.on('pong', () => {
                ws.isAlive = true;
            });

            ws.on('message', (data) => {
                // data is raw PCM if isRecording is true.
                if (this.isRecording && data instanceof Buffer) {
                    // Send the raw PCM chunk to Voxta
                    this.audioWebSocketClient.send(data);
                }
            });

            ws.on('close', () => {
                logger.info('[DEBUG] Device connection closed');
                if (this.deviceSocket === ws) {
                    this.deviceSocket = null;
                }
                ws.isAlive = false;
            });

            ws.on('error', (error) => {
                logger.error('[DEBUG] Device socket error:', error);
                if (this.deviceSocket === ws) {
                    this.deviceSocket = null;
                }
                ws.isAlive = false;
            });
        });

        // Add connection health check interval
        const pingInterval = setInterval(() => {
            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) {
                    logger.info('[DEBUG] Terminating inactive connection');
                    return ws.terminate();
                }
                ws.isAlive = false;
                ws.ping(() => {});
            });
        }, 5000);

        this.wss.on('close', () => {
            clearInterval(pingInterval);
        });

        const port = 3001;
        this.httpServer.listen(port, () => {
            logger.info(`[DEBUG] WebSocket server listening on port ${port}`);
        });

        // On graceful shutdown
        eventBus.on('shutdown', () => {
            clearInterval(pingInterval);
            this.shutdown();
        });
    }

    /**
     * Create the pipeline that decodes inbound MP3 frames → 16 kHz, mono, 16-bit PCM.
     * We'll pipe that PCM into audioWebSocketClient, which sends it to Voxta.
     */
    createMp3Decoder() {
        logger.info('Creating MP3 → PCM decoder pipeline');
        this.decoder = new prism.FFmpeg({
            args: [
                '-analyzeduration', '0',
                '-i', 'pipe:0',
                '-f', 's16le',  // signed 16-bit
                '-ar', '16000', // 16 kHz
                '-ac', '1',     // mono
                'pipe:1'
            ]
        });

        // When the decoder outputs PCM data, we push to Voxta (audio-websocket-client)
        this.decoder.on('data', (chunk) => {
            if (this.isRecording) {
                this.audioWebSocketClient.send(chunk);
            }
        });

        this.decoder.on('error', (err) => {
            logger.error('Decoder error:', err);
        });
    }

    destroyMp3Decoder() {
        if (this.decoder) {
            logger.info('Destroying MP3 decoder pipeline');
            this.decoder.destroy();
            this.decoder = null;
        }
    }

    setupEventListeners() {
        logger.info(`Device bot initialized!`);
        eventBus.on('deviceConnected', (userId) => {
            this.userId = userId;
            logger.info(`Device user id: ${this.userId}`);
            this.startChat();
        });

        eventBus.on('deviceDisconnected', () => {
            this.stopChat();
        });
    }

    /**
     * Connect to Voxta (SignalR), authenticate, etc.
     */
    async connectToVoxta() {
        logger.info('Connecting to Voxta...');
        await this.hubWebSocketClient.start();
        await this.wsMessageService.authenticate();
    }

    /**
     * Resume the last chat (or any chat). Wait for Voxta to send "chatStarting" event → sessionId.
     */
    async startChat() {
        const lastChatId = await this.voxtaApiClient.getLastChatId();
        if (!lastChatId) {
            logger.info('No existing chats found in Voxta. Please create one in the Voxta UI.');
        } else {
            logger.info(`Resuming chat: ${lastChatId}`);
        }
        await this.wsMessageService.resumeChat(lastChatId);
    }

    /**
     * Listen for key events from Voxta:
     * - chatStarting → store official sessionId
     * - chatStarted → device can talk
     * - recordingStatus → if true, connect audioWebSocket & forward PCM from device
     * - speechRecognitionStarted → clear any old STT data
     * - speechRecognitionPartial → update the current partial transcript
     * - speechRecognitionEnd → send recognized text back to Voxta
     */
    handleVoxtaMessage(message) {
        // Ignore messages with a sessionId mismatch (except for chatStarting)
        if (
            message.sessionId &&
            this.sessionId &&
            message.sessionId !== this.sessionId &&
            message.$type !== 'chatStarting'
        ) {
            logger.error(
                `Session mismatch: current=${this.sessionId} incoming=${message.sessionId}`
            );
            return;
        }

        switch (message.$type) {
            case 'chatStarting': {
                this.sessionId = message.sessionId;
                logger.info(`Voxta chatStarting => sessionId = ${this.sessionId}`);
                break;
            }
            case 'chatStarted': {
                this.onChatStarted();
                break;
            }
            case 'chatFlow': {
                // Optionally handle chat flow state changes here.
                break;
            }
            case 'replyGenerating': {
                this.handleReplyGenerating(message);
                break;
            }
            case 'replyChunk': {
                this.handleReplyChunk(message);
                break;
            }
            case 'replyEnd': {
                this.handleReplyEnd(message);
                break;
            }
            case 'recordingStatus': {
                if (message.enabled) {
                    this.onRecordingRequest();
                } else {
                    this.stopRecording();
                }
                break;
            }
            case 'speechRecognitionStarted': {
                // Clear old STT data when a new session starts.
                this.currentPartialText = '';
                break;
            }
            case 'speechRecognitionPartial': {
                // Update the partial transcript.
                this.currentPartialText = message.text;
                break;
            }
            case 'speechRecognitionEnd': {
                this.onSpeechRecognitionEnd(message.text);
                break;
            }
            default:
                // Unhandled message types.
                break;
        }
    }

    async startRecording() {
        logger.info('Voxta requested recording to start');
        this.isRecording = true;
        if (!this.sessionId) {
            logger.error('No sessionId yet, cannot open audio socket!');
            return;
        }
        try {
            await this.audioWebSocketClient.connect(this.sessionId);
        } catch (err) {
            logger.error('Error connecting to audioWebSocketClient:', err);
        }
    }

    stopRecording() {
        logger.info('Voxta requested recording to stop');
        this.isRecording = false;
        this.audioWebSocketClient.close();
    }

    /**
     * Called after receiving recordingStatus with enabled true.
     * Connect the audio input pipeline to Voxta's audio websocket and begin streaming.
     */
    async onRecordingRequest() {
        logger.info('Voxta requests recording start');
        this.isRecording = true;
        if (!this.sessionId) {
            logger.error('No sessionId yet, cannot start streaming audio!');
            return;
        }
        await this.audioWebSocketClient.connect(this.sessionId).catch((err) => {
            logger.error('audioWebSocketClient connect error:', err);
        });
        if (!this.decoder) {
            this.createMp3Decoder();
        }
    }

    /**
     * Handles the final recognized text from speech-to-text.
     * If the final text appears empty or truncated, uses the accumulated partial text.
     */
    onSpeechRecognitionEnd(text) {
        // Use final text if available; otherwise fallback to accumulated partial text.
        const finalText = (text && text.trim().length > 0) ? text : this.currentPartialText;
        if (finalText && this.sessionId) {
            logger.debug(`[DEBUG] Sending recognized text to chat: ${finalText}`);
            this.wsMessageService.send(this.sessionId, finalText);
        } else {
            logger.error('[DEBUG] No sessionId available for sending message or no text recognized');
        }
        // Clear the accumulated partial text.
        this.currentPartialText = '';
        this.lastSentText = null;
        this.lastSentTimestamp = 0;
    }

    /**
     * Called after AudioPlayerService finishes downloading MP3 data for TTS.
     * Forwards the MP3 buffer to the device.
     */
    async onPlayAudio(audioData) {
        if (this.currentlyPlaying) {
            this.currentlyPlaying = false;
        }
        if (!audioData) {
            logger.error('[DEBUG] No audio data received');
            return;
        }
        if (!this.deviceSocket || this.deviceSocket.readyState !== this.deviceSocket.OPEN) {
            logger.error('[DEBUG] No device socket connected');
            return;
        }
        const messageId = audioData.messageId ? audioData.messageId : 'unknown';
        try {
            this.currentlyPlaying = true;
            const pcmData = await this.decodeMp3ToPcm(audioData);
            const BYTES_PER_SECOND = 44100 * 2 * 2;
            const CHUNK_SIZE = 2048;
            let bytesSent = 0;
            const sendNextChunk = () => {
                if (!this.currentlyPlaying) {
                    return;
                }
                if (bytesSent >= pcmData.length) {
                    this.currentlyPlaying = false;
                    eventBus.emit('speechPlaybackComplete', messageId);
                    return;
                }
                if (!this.deviceSocket || this.deviceSocket.readyState !== this.deviceSocket.OPEN) {
                    logger.error('[DEBUG] WebSocket is not open, stopping playback');
                    this.currentlyPlaying = false;
                    return;
                }
                const chunk = pcmData.slice(bytesSent, bytesSent + CHUNK_SIZE);
                this.deviceSocket.send(chunk, { binary: true }, (err) => {
                    if (err) {
                        logger.error('[DEBUG] Chunk send error:', err);
                        this.currentlyPlaying = false;
                    } else {
                        bytesSent += chunk.length;
                        const delay = (CHUNK_SIZE / BYTES_PER_SECOND) * 1000;
                        setTimeout(sendNextChunk, delay);
                    }
                });
            };
            sendNextChunk();
        } catch (err) {
            logger.error('[DEBUG] Error in onPlayAudio:', err);
            this.currentlyPlaying = false;
            eventBus.emit('speechPlaybackComplete', messageId);
        }
    }

    onChatStarted() {
        logger.info('Voxta chatStarted => device can talk now');
        if (this.deviceSocket) {
            const msg = { note: 'Voxta chat started, you can speak.' };
            this.deviceSocket.send(JSON.stringify(msg));
        }
    }

    onSpeechPlaybackComplete(messageId) {
        if (!this.sessionId || !messageId) {
            logger.error('[DEBUG] Missing sessionId or messageId for speechPlaybackComplete');
            return;
        }
        try {
            this.wsMessageService.speechPlaybackComplete(this.sessionId, messageId)
                .catch(err => {
                    logger.error('[DEBUG] Error in speechPlaybackComplete:', err);
                });
        } catch (err) {
            logger.error('[DEBUG] Error in speechPlaybackComplete:', err);
        }
    }

    /**
     * Decodes MP3 => s16le PCM.
     */
    async decodeMp3ToPcm(audioData) {
        return new Promise(async (resolve, reject) => {
            const { Readable } = await import('stream');
            const prismModule = (await import('prism-media')).default;
            const retBuffers = [];
            const inputStream = Readable.from([audioData]);
            const decoder = new prismModule.FFmpeg({
                args: [
                    '-analyzeduration', '0',
                    '-loglevel', '0',
                    '-f', 's16le',
                    '-ar', '44100',
                    '-ac', '2'
                ]
            });
            decoder.on('data', (chunk) => {
                retBuffers.push(chunk);
            });
            decoder.on('end', () => {
                const result = Buffer.concat(retBuffers);
                resolve(result);
            });
            decoder.on('error', (err) => {
                logger.error('[DEBUG] FFmpeg decoder error:', err);
                reject(err);
            });
            inputStream
                .pipe(decoder)
                .on('error', (err) => {
                    logger.error('[DEBUG] Pipeline error:', err);
                    reject(err);
                });
        });
    }

    async shutdown() {
        logger.info('Shutting down DeviceServer...');
        this.stopRecording();
        
        // Close all client connections
        if (this.wss) {
            this.wss.clients.forEach((client) => {
                client.terminate();
            });
        }
        
        if (this.deviceSocket) {
            this.deviceSocket.terminate();
            this.deviceSocket = null;
        }
        
        // Close server
        if (this.wss) {
            this.wss.close();
        }
        if (this.httpServer) {
            await new Promise((resolve) => {
                this.httpServer.close(resolve);
            });
        }
        await this.hubWebSocketClient.stop();
    }

    handleReplyGenerating(message) {
        const { messageId, sessionId } = message;
        logger.info(`Initializing buffer for message ${messageId}`);
        // Clear any previous audio buffers and STT partial text to avoid accumulation
        this.audioBuffers = {};
        this.currentPartialText = '';
        this.currentMessageId = messageId;
        this.audioBuffers[messageId] = {
            chunks: [],
            isComplete: false,
            sessionId,
            isPlaying: false
        };
    }
    
    handleReplyChunk(message) {
        const { messageId } = message;
        logger.info(`Received chunk for message ${messageId}`);
        if (!this.audioBuffers[messageId]) {
            logger.warn(`No buffer found for message ${messageId}—creating one on-the-fly.`);
            this.audioBuffers[messageId] = {
                chunks: [],
                isComplete: false,
                sessionId: message.sessionId,
                isPlaying: false
            };
        }
        this.audioBuffers[messageId].chunks.push(message);
        this.playBuffer(messageId).catch(err =>
            logger.error(`[DEBUG] playBuffer error for msg ${messageId}:`, err)
        );
    }
    
    handleReplyEnd(message) {
        const { messageId } = message;
        logger.info(`Marking message ${messageId} as complete`);
        const buffer = this.audioBuffers[messageId];
        if (buffer) {
            buffer.isComplete = true;
            this.checkAndSendPlaybackComplete(messageId).catch(err =>
                logger.error(`[DEBUG] checkAndSendPlaybackComplete error:`, err)
            );
        }
    }
    
    getNextValidChunk(messageBuffer) {
        while (messageBuffer.chunks.length > 0) {
            const chunk = messageBuffer.chunks.shift();
            if (chunk?.audioUrl?.length) {
                return chunk;
            }
        }
        return null;
    }
    
    async playBuffer(messageId) {
        const messageBuffer = this.audioBuffers[messageId];
        if (!messageBuffer || messageBuffer.isPlaying) {
            return;
        }
        messageBuffer.isPlaying = true;
        let chunk = this.getNextValidChunk(messageBuffer);
        while (chunk) {
            try {
                const fullUrl = new URL(chunk.audioUrl, CONFIG.voxta.baseUrl).toString();
                const response = await fetch(fullUrl);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                const audioBuffer = Buffer.from(await response.arrayBuffer());
                const pcmData = await this.decodeMp3ToPcm(audioBuffer);
                await this.streamPcmToDevice(pcmData, chunk.messageId);
            } catch (error) {
                logger.error(`Error fetching/playing chunk for msg ${messageId}:`, error);
                messageBuffer.isPlaying = false;
                return;
            }
            chunk = this.getNextValidChunk(messageBuffer);
        }
        messageBuffer.isPlaying = false;
        await this.checkAndSendPlaybackComplete(messageId);
        if (messageBuffer.chunks.length > 0) {
            await this.playBuffer(messageId);
        }
    }
    
    async checkAndSendPlaybackComplete(messageId) {
        const messageBuffer = this.audioBuffers[messageId];
        if (!messageBuffer) return;
        if (messageBuffer.isComplete && messageBuffer.chunks.length === 0) {
            this.onSpeechPlaybackComplete(messageId);
            delete this.audioBuffers[messageId];
        }
    }
    
    async streamPcmToDevice(pcmData, messageId) {
        return new Promise((resolve, reject) => {
            let bytesSent = 0;
            const CHUNK_SIZE = 2048;
            const BYTES_PER_SECOND = 44100 * 2 * 2;
            const sendNextChunk = () => {
                if (!this.deviceSocket || this.deviceSocket.readyState !== this.deviceSocket.OPEN) {
                    logger.error('[DEBUG] WebSocket is not open, stopping playback');
                    return reject(new Error('Device socket not open'));
                }
                if (bytesSent >= pcmData.length) {
                    return resolve();
                }
                const chunk = pcmData.slice(bytesSent, bytesSent + CHUNK_SIZE);
                this.deviceSocket.send(chunk, { binary: true }, (err) => {
                    if (err) {
                        logger.error('[DEBUG] Chunk send error:', err);
                        return reject(err);
                    }
                    bytesSent += chunk.length;
                    const delay = (CHUNK_SIZE / BYTES_PER_SECOND) * 1000;
                    setTimeout(sendNextChunk, delay);
                });
            };
            sendNextChunk();
        });
    }
}

export default DeviceBot;
