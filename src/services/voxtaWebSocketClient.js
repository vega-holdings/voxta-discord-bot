import * as signalR from '@microsoft/signalr';
import logger from '../utils/logger.js';
import eventBus from '../utils/eventBus.js';

class VoxtaWebSocketClient {
    constructor(baseUrl, headers) {
        this.baseUrl = baseUrl;
        this.headers = headers;
        this.connection = null;
        this.sessionId = null;
        this.messageBuffer = [];
        this.authenticated = false;
        eventBus.on('cleanup', () => this.cleanup());
    }

    setupSignalRConnection(wsUrl) {
        const connection = new signalR.HubConnectionBuilder()
            .withUrl(wsUrl, { headers: this.headers })
            .withAutomaticReconnect()
            .configureLogging(signalR.LogLevel.Information)
            .build();

        connection.on("ReceiveMessage", this.handleReceiveMessage.bind(this));
        return connection;
    }

    async connect() {
        if (this.connection) {
            return;
        }

        const wsUrl = `${this.baseUrl}/hub`;
        this.connection = this.setupSignalRConnection(wsUrl);

        try {
            await this.connection.start();
            logger.info('Connected to Voxta WebSocket');
            await this.authenticate();
        } catch (error) {
            logger.error('Error connecting to Voxta WebSocket:', error);
            this.connection = null;
            throw error;
        }
    }

    async authenticate() {
        if (this.authenticated) return;
        
        await this.connect();

        await this.connection.invoke('SendMessage', {
            "$type": "authenticate",
            "client": "SimpleClient",
            "clientVersion": "1.0",
            "scope": ["role:app"],
            "capabilities": {
                "audioInput": "None", 
                "audioOutput": "Url",
                "acceptedAudioContentTypes": ["audio/x-wav", "audio/mpeg"]
            }
        });
        
        this.authenticated = true;
    }

    async sendWebSocketMessage(type, payload = {}) {
        const message = {
            $type: type,
            ...payload
        };
        
        this.messageBuffer.push(message);
        
        if (this.sessionId) {
            await this.processMessageBuffer();
        }
    }

    async sendMessage(text) {
        await this.sendWebSocketMessage('send', {
            text: text,
            doReply: true,
            doCharacterActionInference: true
        });
    }

    async processMessageBuffer() {
        if (!this.connection || !this.sessionId) return;

        logger.info('Processing message buffer, size:', this.messageBuffer.length);

        while (this.messageBuffer.length > 0) {
            const message = this.messageBuffer.shift();
            message.sessionId = this.sessionId;
            
            try {
                await this.connection.invoke('SendMessage', message);
            } catch (error) {
                logger.error('Error sending message to Voxta:', error);
                this.messageBuffer.unshift(message);
                break;
            }
        }
    }

    async resumeChat(chatId) {
        await this.connection.invoke('SendMessage', {
            "$type": "resumeChat",
            "chatId": chatId
        });
        logger.info('Resumed chat with ID:', chatId);
    }

    async handleReceiveMessage(message) {
        logger.info('Received message from Voxta:', message);
        
        eventBus.emit('voxtaMessage', message);
        
        // Handle chat session started message
        if (message.$type === 'chatStarted' && message.context?.sessionId) {
            this.sessionId = message.context.sessionId;
            logger.info('Chat session started with ID:', this.sessionId);
            await this.processMessageBuffer();
        }
    }

    async cleanup() {
        if (this.connection) {
            await this.connection.stop();
            this.connection = null;
        }
    }
}

export default VoxtaWebSocketClient;
