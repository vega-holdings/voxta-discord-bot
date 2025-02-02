import asyncio
import websockets
import pyaudio
import json
import logging
import struct
import tempfile
from datetime import datetime

class MyClass:
    def __init__(self):
        # Create a logger for the class
        self.logger = logging.getLogger(__name__)
        self.logger.setLevel(logging.DEBUG)

        # Create a handler to output to the console
        console_handler = logging.StreamHandler()
        console_handler.setLevel(logging.DEBUG)

        # Create a formatter for the output
        formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
        console_handler.setFormatter(formatter)

        # Add the handler to the logger
        self.logger.addHandler(console_handler)

    def do_something(self):
        self.logger.debug("This is a debug message")

if __name__ == "__main__":
    obj = MyClass()
    obj.do_something()

class VoxtaClient:
    def __init__(self, server_url):
        # Setup logging
        logging.basicConfig(level=logging.INFO)
        self.logger = logging.getLogger('VoxtaClient')

        # Configuration
        self.server_url = server_url

        # --- Microphone (Inbound) Settings ---
        # We'll capture 16kHz, mono, 16-bit from the mic
        self.IN_CHUNK = 1024
        self.IN_FORMAT = pyaudio.paInt16
        self.IN_CHANNELS = 1
        self.IN_RATE = 16000

        # --- Speaker (Outbound) Settings ---
        # Suppose the server is sending 44.1kHz stereo
        # Adjust these to match the PCM format the server sends
        self.OUT_FORMAT = pyaudio.paInt16
        self.OUT_CHANNELS = 2
        self.OUT_RATE = 44100
        self.OUT_CHUNK = 2048

        # Initialize PyAudio
        self.audio = pyaudio.PyAudio()

        # Debug device info if needed (set the condition to True)
        if False:
            device_count = self.audio.get_device_count()
            self.logger.debug(f"Found {device_count} audio devices:")
            for i in range(device_count):
                dev_info = self.audio.get_device_info_by_index(i)
                self.logger.debug(f"Device {i}: {dev_info['name']} | "
                                  f"In channels: {dev_info['maxInputChannels']} | "
                                  f"Sample rate: {dev_info['defaultSampleRate']}")

        # Create microphone input stream
        # Adjust input_device_index if needed
        self.mic_stream = self.audio.open(
            format=self.IN_FORMAT,
            channels=self.IN_CHANNELS,
            rate=self.IN_RATE,
            input=True,
            frames_per_buffer=self.IN_CHUNK,
            input_device_index=None  # or a valid device index if you know it
        )

        # Create speaker output stream
        self.speaker_stream = self.audio.open(
            format=self.OUT_FORMAT,
            channels=self.OUT_CHANNELS,
            rate=self.OUT_RATE,
            output=True,
            frames_per_buffer=self.OUT_CHUNK
        )

        # Diagnostics
        self.bytes_sent = 0
        self.bytes_received = 0
        self.packets_sent = 0
        self.packets_received = 0

        # Silence threshold
        self.amplitude_threshold = 300

        # If the server expects an initial format handshake, we can store it here
        self.format_info = {
            "type": "audioFormat",
            "contentType": "audio/wav",
            "sampleRate": self.IN_RATE,
            "channels": self.IN_CHANNELS,
            "bitsPerSample": 16,
            "bufferMilliseconds": 30
        }

    async def capture_mic_and_send(self, websocket):
        """
        Continuously read audio from the microphone and send raw PCM to the server.
        """
        self.logger.info("Starting to capture mic data and send to server...")
        try:
            while True:
                # Read raw PCM from mic
                audio_data = self.mic_stream.read(self.IN_CHUNK, exception_on_overflow=False)
                # Check amplitude for voice activity
                samples = struct.unpack(f"{self.IN_CHUNK}h", audio_data)
                max_amplitude = max(abs(x) for x in samples)

                if max_amplitude > self.amplitude_threshold:
                    await websocket.send(audio_data)
                    self.bytes_sent += len(audio_data)
                    self.packets_sent += 1

                    if self.packets_sent % 10 == 0:
                        self.logger.info(
                            f"Audio OUT - total bytes sent: {self.bytes_sent}, "
                            f"packets sent: {self.packets_sent}, "
                            f"last amplitude: {max_amplitude}"
                        )

                await asyncio.sleep(0.01)

        except asyncio.CancelledError:
            self.logger.info("capture_mic_and_send task was cancelled.")
        except Exception as e:
            self.logger.error(f"Error capturing mic or sending data: {e}")

    async def receive_and_play(self, websocket):
        """Handle receiving audio data from server and playing it."""
        self.logger.info("Starting audio playback handler")
        
        try:
            async for message in websocket:
                # Log raw message info
                self.logger.debug(f"Received message type: {type(message)}")
                if isinstance(message, bytes):
                    self.logger.debug(f"Received binary audio chunk: {len(message)} bytes")
                else:
                    self.logger.debug(f"Received text message: {message[:100]}...")

                # If it's text, try to parse as JSON
                if isinstance(message, str):
                    try:
                        msg_json = json.loads(message)
                        self.logger.debug(f"Decoded JSON message: {msg_json}")
                        continue  # Skip audio processing for text messages
                    except json.JSONDecodeError:
                        self.logger.debug("Message is not JSON, treating as text")

                # Audio data processing
                if isinstance(message, bytes):
                    self.logger.debug(f"Attempting to play {len(message)} byte audio chunk")
                    
                    # Write to temporary file for debugging
                    with tempfile.NamedTemporaryFile(delete=False, suffix=".raw") as tmp:
                        tmp.write(message)
                        self.logger.debug(f"Wrote raw audio to {tmp.name}")
                    
                    try:
                        # Attempt playback
                        self.logger.debug("Starting audio playback")
                        self.speaker_stream.write(message)
                        self.logger.debug("Audio chunk successfully played")
                    except Exception as e:
                        self.logger.error(f"Playback error: {e}")
                        # Write error log with timestamps
                        with open("audio_errors.log", "a") as f:
                            f.write(f"{datetime.now()} - {str(e)}\n")

        except Exception as e:
            self.logger.error(f"Receive/play error: {e}")

    async def run(self):
        self.logger.info(f"Connecting to server: {self.server_url}")
        try:
            async with websockets.connect(self.server_url) as websocket:
                self.logger.info("WebSocket connection established")
                
                self.logger.info("Audio streams ready")

                # Create tasks for sending and receiving
                self.logger.info("Starting send/receive tasks")
                send_task = asyncio.create_task(self.capture_mic_and_send(websocket))
                recv_task = asyncio.create_task(self.receive_and_play(websocket))

                try:
                    # Wait for tasks
                    done, pending = await asyncio.wait(
                        [send_task, recv_task],
                        return_when=asyncio.FIRST_EXCEPTION
                    )
                    self.logger.info("Tasks completed or exception occurred")
                    
                    # Check for exceptions
                    for task in done:
                        if task.exception():
                            self.logger.error(f"Task failed with error: {task.exception()}")
                            raise task.exception()
                except Exception as e:
                    self.logger.error(f"Error in tasks: {e}")
                finally:
                    # Cancel pending tasks
                    for task in pending:
                        task.cancel()
                        self.logger.info(f"Cancelled task: {task}")

        except websockets.exceptions.ConnectionClosed:
            self.logger.error("WebSocket connection closed unexpectedly")
        except Exception as e:
            self.logger.error(f"Connection error: {e}")
        finally:
            self.cleanup()

    def cleanup(self):
        self.logger.info("Cleaning up audio resources...")
        try:
            if self.mic_stream:
                self.mic_stream.stop_stream()
                self.mic_stream.close()
            if self.speaker_stream:
                self.speaker_stream.stop_stream()
                self.speaker_stream.close()
            if self.audio:
                self.audio.terminate()
        except Exception as e:
            self.logger.error(f"Error during cleanup: {e}")

async def main():
    SERVER_URL = "ws://localhost:3001"
    client = VoxtaClient(SERVER_URL)
    await client.run()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nExiting...")
