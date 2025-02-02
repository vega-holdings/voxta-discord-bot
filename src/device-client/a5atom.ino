#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <driver/i2s.h>
#include <M5Atom.h>
#include <vector>

// Add after the includes
#define COLOR_RED    0xff0000
#define COLOR_GREEN  0x00ff00
#define COLOR_BLUE   0x0000ff
#define COLOR_ORANGE 0xff8c00
#define COLOR_PURPLE 0xff00ff

// --- WiFi & Server Configuration ---
#define WIFI_SSID       "#FUNT"
#define WIFI_PASSWORD   "9D@4iJwnA1mQ2AGKP1u!"
#define SERVER_URL      "ws://192.168.1.160:3001" // Replace with your server's address

// --- I2S Configuration for Microphone (16kHz, mono) ---
#define MIC_I2S_PORT            I2S_NUM_0
#define MIC_I2S_SAMPLE_RATE     16000
#define MIC_I2S_CHANNELS        1
#define MIC_I2S_BITS_PER_SAMPLE I2S_BITS_PER_SAMPLE_16BIT
#define MIC_I2S_BUFFER_SIZE     1024            // in bytes
#define MIC_I2S_READ_TIMEOUT_MS 100
#define MIC_I2S_PIN_DATA        25
#define MIC_I2S_PIN_BCK         22
#define MIC_I2S_PIN_WS          21

// --- I2S Configuration for Speaker (44.1kHz, stereo) ---
#define SPK_I2S_PORT            I2S_NUM_1
#define SPK_I2S_SAMPLE_RATE     44100
#define SPK_I2S_CHANNELS        2
#define SPK_I2S_BITS_PER_SAMPLE I2S_BITS_PER_SAMPLE_16BIT
#define SPK_I2S_BUFFER_SIZE     2048            // in bytes (adjust as needed)
#define SPK_I2S_PIN_BCK         26
#define SPK_I2S_PIN_WS          27
#define SPK_I2S_PIN_DATA        32

// --- Audio Settings ---
#define AMPLITUDE_THRESHOLD   300  // Only send mic audio above this amplitude

// --- Diagnostics ---
volatile int bytesSent     = 0;
volatile int bytesReceived = 0;
volatile int packetsSent   = 0;
volatile int packetsReceived = 0;
volatile bool isConnected  = false;

// --- I2S Buffers ---
uint8_t mic_i2s_read_buff[MIC_I2S_BUFFER_SIZE];
uint8_t spk_i2s_write_buff[SPK_I2S_BUFFER_SIZE];  // Used only if any processing were needed

// --- JSON Document for handshake ---
StaticJsonDocument<200> doc;

// --- WebSocket Client ---
WebSocketsClient webSocket;

// Global variable for connection state
bool wsConnected = false;

// Add near the top with other global variables
bool isButtonPressed = false;
bool isSpeakerActive = false;

// =====================================================
//   WiFi Initialization
// =====================================================
void initWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("Connecting to WiFi: %s\n", WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\nWiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());
}

// =====================================================
//   I2S Initialization for Microphone
// =====================================================
void initI2S_mic() {
  i2s_config_t mic_i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = MIC_I2S_SAMPLE_RATE,
    .bits_per_sample = MIC_I2S_BITS_PER_SAMPLE,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,  // mono
    .communication_format = I2S_COMM_FORMAT_I2S_MSB,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 4,
    .dma_buf_len = MIC_I2S_BUFFER_SIZE / 2, // in samples (2 bytes per sample)
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  i2s_pin_config_t mic_pin_config = {
    .bck_io_num = MIC_I2S_PIN_BCK,
    .ws_io_num  = MIC_I2S_PIN_WS,
    .data_out_num = I2S_PIN_NO_CHANGE, // Not used for RX
    .data_in_num  = MIC_I2S_PIN_DATA
  };

  esp_err_t err = i2s_driver_install(MIC_I2S_PORT, &mic_i2s_config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("Error installing I2S mic driver: %d\n", err);
  }
  err = i2s_set_pin(MIC_I2S_PORT, &mic_pin_config);
  if (err != ESP_OK) {
    Serial.printf("Error setting I2S mic pins: %d\n", err);
  }
  err = i2s_set_clk(MIC_I2S_PORT, MIC_I2S_SAMPLE_RATE, MIC_I2S_BITS_PER_SAMPLE, I2S_CHANNEL_MONO);
  if (err != ESP_OK) {
    Serial.printf("Error setting I2S mic clock: %d\n", err);
  }
}

// =====================================================
//   I2S Initialization for Speaker
// =====================================================
void initI2S_spk() {
  i2s_config_t spk_i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = SPK_I2S_SAMPLE_RATE,
    .bits_per_sample = SPK_I2S_BITS_PER_SAMPLE,
    .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S_MSB,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 4,
    .dma_buf_len = 1024,
    .use_apll = true,  // Use APLL for better audio quality
    .tx_desc_auto_clear = true,
    .fixed_mclk = 0
  };

  // Stop any existing I2S driver
  i2s_driver_uninstall(SPK_I2S_PORT);

  // Install and configure I2S driver
  esp_err_t err = i2s_driver_install(SPK_I2S_PORT, &spk_i2s_config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("Error installing I2S speaker driver: %d\n", err);
    return;
  }

  i2s_pin_config_t spk_pin_config = {
    .bck_io_num = SPK_I2S_PIN_BCK,
    .ws_io_num = SPK_I2S_PIN_WS,
    .data_out_num = SPK_I2S_PIN_DATA,
    .data_in_num = I2S_PIN_NO_CHANGE
  };

  err = i2s_set_pin(SPK_I2S_PORT, &spk_pin_config);
  if (err != ESP_OK) {
    Serial.printf("Error setting I2S speaker pins: %d\n", err);
    return;
  }

  // Clear the DMA buffer
  err = i2s_zero_dma_buffer(SPK_I2S_PORT);
  if (err != ESP_OK) {
    Serial.printf("Error clearing DMA buffer: %d\n", err);
  }

  Serial.println("I2S speaker initialized successfully");
}

// =====================================================
//   WebSocket Event Handler
// =====================================================
void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.println("WebSocket Disconnected");
      isConnected = false;
      break;
      
    case WStype_CONNECTED:
      Serial.println("WebSocket Connected");
      isConnected = true;
      // Send initial audio format info
      doc.clear();
      doc["type"] = "audioFormat";
      doc["contentType"] = "audio/wav";
      doc["sampleRate"] = MIC_I2S_SAMPLE_RATE;
      doc["channels"] = MIC_I2S_CHANNELS;
      doc["bitsPerSample"] = 16;
      doc["bufferMilliseconds"] = 30;
      {
        String jsonString;
        serializeJson(doc, jsonString);
        webSocket.sendTXT(jsonString);
      }
      break;
      
    case WStype_ERROR:
      Serial.printf("WebSocket Error: %s\n", payload);
      break;
      
    case WStype_TEXT:
      Serial.printf("Received text: %s\n", payload);
      // Here you could add logic to parse commands or configuration from text messages
      break;
      
    case WStype_BIN: {
      Serial.printf("Received binary data of length: %d\n", length);
      
      if (length < 32) {  // Increased minimum size check
        Serial.println("Received data too small, skipping");
        break;
      }

      // Check for invalid patterns (all 0s or all FFs)
      bool allZeros = true;
      bool allOnes = true;
      bool hasValidAudio = false;
      
      // Check first 32 bytes for patterns
      for (int i = 0; i < 32; i++) {
        if (payload[i] != 0x00) allZeros = false;
        if (payload[i] != 0xFF) allOnes = false;
        // Look for values between 0x10 and 0xF0 as likely valid audio
        if (payload[i] > 0x10 && payload[i] < 0xF0) hasValidAudio = true;
      }

      if (allZeros || allOnes) {
        Serial.println("Invalid audio pattern detected (all 0s or all FFs), skipping");
        break;
      }

      if (!hasValidAudio) {
        Serial.println("No valid audio data detected, skipping");
        break;
      }

      // Print sample of the data for debugging
      Serial.print("Audio data sample: ");
      for (int i = 0; i < 16; i++) {
        Serial.printf("%02X ", payload[i]);
      }
      Serial.println();

      // Set speaker active flag and update LED
      isSpeakerActive = true;
      updateLED();

      // Clear the DMA buffer before playing new audio
      esp_err_t err = i2s_zero_dma_buffer(SPK_I2S_PORT);
      if (err != ESP_OK) {
        Serial.printf("Error clearing DMA buffer: %d\n", err);
      }
      
      // Write the audio data to the speaker
      size_t bytes_written = 0;
      err = i2s_write(SPK_I2S_PORT, (const char*)payload, length, &bytes_written, portMAX_DELAY);
      
      if (err != ESP_OK) {
        Serial.printf("Error writing to speaker I2S: %d\n", err);
      } else {
        Serial.printf("Playing audio data: %d of %d bytes written\n", bytes_written, length);
        bytesReceived += bytes_written;
        packetsReceived++;
      }

      // Wait for the audio to finish playing
      int playbackDelayMs = (length * 1000) / (SPK_I2S_SAMPLE_RATE * 4);  // Calculate actual playback time
      delay(playbackDelayMs + 10);  // Add small buffer

      // Clear the buffer after playing
      err = i2s_zero_dma_buffer(SPK_I2S_PORT);
      if (err != ESP_OK) {
        Serial.printf("Error clearing DMA buffer after playback: %d\n", err);
      }

      // Clear speaker active flag and update LED
      isSpeakerActive = false;
      updateLED();
      break;
    }
    
    default:
      break;
  }
}

// =====================================================
//   Task: Capture Microphone Audio and Send via WebSocket
// =====================================================
void captureMicAndSend(void* parameter) {
  Serial.println("Starting microphone capture task");
  
  while (true) {
    // Only capture and send audio when button is pressed
    if (isConnected && isButtonPressed) {
      size_t bytes_read = 0;
      esp_err_t err = i2s_read(MIC_I2S_PORT, (void*)mic_i2s_read_buff, MIC_I2S_BUFFER_SIZE, &bytes_read, MIC_I2S_READ_TIMEOUT_MS);
      
      if (err != ESP_OK) {
        Serial.printf("Error reading from mic I2S: %d\n", err);
        delay(100);
        continue;
      }
      
      if (bytes_read > 0) {
        // Send audio data to WebSocket without amplitude check
        webSocket.sendBIN(mic_i2s_read_buff, bytes_read);
        bytesSent += bytes_read;
        packetsSent++;
        
        // Debug print periodically
        static unsigned long lastPrint = 0;
        if (millis() - lastPrint > 1000) {
          Serial.printf("Audio OUT - bytes sent: %d\n", bytes_read);
          lastPrint = millis();
        }
      }
    }
    delay(10);
  }
}

// =====================================================
//   Task: Dummy Task for Playback (handled in WS event)
// =====================================================
void receiveAndPlay(void* parameter) {
  while (true) {
    delay(10);
  }
}

// =====================================================
//   Setup & Loop
// =====================================================
void setup() {
  Serial.begin(115200);
  M5.begin(true, true, true);
  
  // Initialize WiFi first
  initWiFi();
  
  // Initialize I2S for microphone
  initI2S_mic();
  
  // Initialize I2S for speaker with explicit flush
  initI2S_spk();
  
  // Flush any pending data
  size_t bytes_cleared;
  uint8_t clear_buffer[512];
  i2s_read(SPK_I2S_PORT, clear_buffer, sizeof(clear_buffer), &bytes_cleared, 0);
  
  // Parse the SERVER_URL into host, port, and path
  String url = String(SERVER_URL);
  Serial.printf("Connecting to WebSocket URL: %s\n", url.c_str());
  
  // Remove "ws://" prefix
  url = url.substring(5); 
  
  // Find port and path separators
  int portIndex = url.indexOf(':');
  int pathIndex = url.indexOf('/', portIndex);
  
  // Extract components
  String serverHost = url.substring(0, portIndex);
  String portStr;
  String serverPath;
  
  if (pathIndex == -1) {
    portStr = url.substring(portIndex + 1);
    serverPath = "/";
  } else {
    portStr = url.substring(portIndex + 1, pathIndex);
    serverPath = url.substring(pathIndex);
  }
  
  uint16_t serverPort = portStr.toInt();

  // Debug print
  Serial.printf("Parsed WebSocket URL:\n");
  Serial.printf("Host: %s\n", serverHost.c_str());
  Serial.printf("Port: %d\n", serverPort);
  Serial.printf("Path: %s\n", serverPath.c_str());

  // Initialize WebSocket with more debug options
  webSocket.begin(serverHost.c_str(), serverPort, serverPath.c_str());
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
  webSocket.enableHeartbeat(15000, 3000, 2);

  // Create tasks
  xTaskCreatePinnedToCore(captureMicAndSend, "captureMicTask", 10240, NULL, 2, NULL, 0);
  xTaskCreatePinnedToCore(receiveAndPlay, "receivePlayTask", 10240, NULL, 1, NULL, 1);
}

void loop() {
  webSocket.loop();
  M5.update();  // Required to update button state
  
  // Check button state
  if (M5.Btn.wasPressed()) {
    isButtonPressed = true;
    M5.dis.drawpix(0, COLOR_RED);  // Red LED when recording
    Serial.println("Button pressed - starting audio capture");
  }
  
  if (M5.Btn.wasReleased()) {
    isButtonPressed = false;
    updateLED();  // Return to normal LED state
    Serial.println("Button released - stopping audio capture");
  }
  
  delay(10);
}

// Update LED based on connection and recording state
void updateLED() {
  if (WiFi.status() != WL_CONNECTED) {
    M5.dis.drawpix(0, COLOR_ORANGE);  // Orange when no WiFi
  } else if (!isConnected) {
    M5.dis.drawpix(0, COLOR_BLUE);    // Blue when WiFi connected but no WebSocket
  } else if (isSpeakerActive) {
    M5.dis.drawpix(0, COLOR_PURPLE);  // Purple when playing audio
  } else if (isButtonPressed) {
    M5.dis.drawpix(0, COLOR_RED);     // Red when recording
  } else {
    M5.dis.drawpix(0, COLOR_GREEN);   // Green when ready
  }
}
