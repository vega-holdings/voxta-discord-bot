import { joinVoiceChannel, EndBehaviorType, createAudioPlayer, createAudioResource } from '@discordjs/voice';
import logger from '../utils/logger.js';
import eventBus from '../utils/eventBus.js';

class VoiceService {
    static instance = null;

    static joinVoiceChannel(client, state) {
        const currentInstance = VoiceService.instance;
        if (currentInstance) {
            currentInstance.cleanup();
        }
        const newInstance = new VoiceService(client, state);
        VoiceService.instance = newInstance;
        return newInstance;
    }

    constructor(client, state) {
        this.client = client;
        this.player = createAudioPlayer();
        this.state = state;

        this.connection = joinVoiceChannel({
            channelId: this.state.channelId,
            guildId: this.state.guild.id,
            adapterCreator: this.state.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });

        logger.info(`Joined voice channel ${this.state.channel.name}`);
        eventBus.emit('voiceChannelJoined', this.state.channel);

        const receiver = this.connection.receiver;

        receiver.speaking.on('start', this.handleSpeakingStart.bind(this));
        receiver.speaking.on('end', this.handleSpeakingEnd.bind(this));

        eventBus.on('cleanup', () => this.cleanup());
    }

    async handleSpeakingStart(userId) {
        const user = this.client.users.cache.get(userId);
        if (!user) return;
        
        logger.info(`User ${user.tag} started speaking`);
        
        const audioStream = this.connection.receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterInactivity,
                duration: 1000
            }
        });

        audioStream.on('data', (chunk) => {
            eventBus.emit('audioData', chunk);
        });
    }

    handleSpeakingEnd(userId) {
        const user = this.client.users.cache.get(userId);
        if (!user) return;
        
        logger.info(`User ${user.tag} stopped speaking`);
        this.connection.receiver.subscriptions.get(userId)?.destroy();
    }

    async playStream(stream) {
        try {
            const resource = createAudioResource(stream);
            this.connection.subscribe(this.player);
            this.player.play(resource);

            return new Promise((resolve, reject) => {
                this.player.on('stateChange', (oldState, newState) => {
                    if (newState.status === 'idle') {
                        resolve();
                    }
                });
                
                this.player.on('error', (error) => {
                    logger.error('Error playing audio:', error);
                    reject(error);
                });
            });
        } catch (error) {
            logger.error('Error creating audio resource:', error);
            throw error;
        }
    }
    cleanup() {
        // Cleanup existing audio subscriptions
        this.connection.receiver?.subscriptions.forEach((subscription) => {
            subscription.destroy();
        });

        if (this.player) {
            this.player.stop();
        }
    }
}

export default VoiceService;
