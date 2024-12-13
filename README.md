# Discord Voice Transcription Bot

A Discord bot that transcribes voice to text and interacts via Voxta to generate voice responses.

## Features

- Automatically connects to your most recent Voxta chat when users join voice channels
- Real-time voice transcription using Deepgram
- Response generation via Voxta
- Audio playback of responses in voice channel

## Prerequisites

- Node.js 20 or higher
- Docker (optional)
- Deepgram API key
- Discord Bot token
- Voxta server

## Configuration

1. Copy the `.env.example` file to `.env`
2. Configure the environment variables:

   ```
   DISCORD_TOKEN=your_discord_token
   DEEPGRAM_API_KEY=your_deepgram_api_key
   VOXTA_URL=your_voxta_server_url  # Optional, defaults to http://localhost:5384
   LANGUAGE=en-US  # Optional, defaults to en-US
   ```

## Installation

### Without Docker

```bash
npm install
node src/daemon.js
```

### With Docker

```bash
make build  # Build the image
make run    # Run the container
```

## Usage

1. Make sure your Voxta server is running
2. Create at least one chat on Voxta (the bot will join the most recently created chat)
3. Invite the bot to your Discord server
2. Join a voice channel
3. The bot will automatically join the channel
4. Speak normally, the bot will transcribe your voice
5. Responses will be automatically generated and played

## Project Structure

- `src/`
  - `services/` : Main services (Deepgram, Voxta, Audio, etc.)
  - `utils/` : Utilities (logger, eventBus)
  - `config/` : Configuration
  - `daemon.js` : Process manager
  - `index.js` : Main entry point
