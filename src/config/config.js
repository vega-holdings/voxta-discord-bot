import 'dotenv/config';

const CONFIG = {
    voxta: {
        baseUrl: process.env.VOXTA_URL || "http://localhost:5384"
    },
    discord: {
        token: process.env.DISCORD_TOKEN
    },
    device: {
        token: process.env.DEVICE_TOKEN
    },
    audio: {
        mode: process.env.AUDIO_MODE || 'discord'
    }
};

export default CONFIG;