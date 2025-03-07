// LoRa Ground Station using Browser Web Serial API
class GroundStation {
  constructor() {
    // Serial port handling
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readableStreamClosed = null;
    this.writableStreamClosed = null;
    this.isReceiving = false;
    this.abortController = null;

    // Display elements
    this.logElement = document.getElementById("log");
    this.imgElement = document.getElementById("receivedImage");
    this.progressBar = document.getElementById("progressBar");
    this.progressText = document.getElementById("progressText");
    this.configureCheckbox = document.getElementById("configureDevice");

    // Constants matching lora.py
    this.PROTOCOL_HEADER_SIZE = 16;
    this.CHUNK_SIZE = 200;
    this.RF_CONFIG = {
      baudRate: 230400,
      frequency: 868,
      spreadingFactor: 7,
      bandwidth: 250,
      powerDbm: 14,
    };
    this.AT_RXLRPKT = "AT+TEST=RXLRPKT\n";
    this.RETRANSMISSION_TIMEOUT = 10000; // Increased to 15 seconds
    this.RX_SWITCH_DELAY = 1000; // Increased to 1 second
    this.VERBOSE = false;
    this.lastChunkTime = 0;
    this.CHUNK_TIMEOUT = 5000; // 5 seconds timeout for individual chunks

    // Reception state
    this.buffer = new Uint8Array();
    this.incomingBytes = 0;
    this.width = 0;
    this.height = 0;
    this.startTime = null;
    this.chunksReceived = {};
    this.bytesReceived = 0;
    this.numExpectedChunks = null;
    this.missingChunks = new Set();
  }

  log(message, type = "info") {
    const timestamp = new Date().toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const prefixes = {
      error: "[-] ",
      success: "[+] ",
      info: "[*] ",
    };
    const prefix = prefixes[type] || prefixes.info;

    // Log to console
    const consoleMethod = type === "error" ? "error" : "log";
    console[consoleMethod](`${prefix}${message}`);

    // Update UI log
    if (this.logElement) {
      const entry = document.createElement("div");
      entry.className = `log-${type}`;
      entry.textContent = `${timestamp}: ${prefix}${message}`;
      this.logElement.appendChild(entry);

      // Check if we're near the bottom before adding new content
      const isNearBottom =
        this.logElement.scrollHeight -
          this.logElement.scrollTop -
          this.logElement.clientHeight <
        50;

      // Force scroll to bottom if we were already near the bottom
      if (isNearBottom) {
        this.logElement.scrollTop = this.logElement.scrollHeight;
      }
    }
  }

  updateProgress(received, total) {
    const percent = total > 0 ? Math.round((received / total) * 100) : 0;
    if (this.progressBar) {
      this.progressBar.style.width = `${percent}%`;
    }
    if (this.progressText) {
      this.progressText.textContent = `${percent}% (${received}/${total} bytes)`;
    }
  }

  async requestPort() {
    if (!navigator.serial) {
      throw new Error("Web Serial API is not supported in this browser");
    }

    try {
      this.port = await navigator.serial.requestPort();
      this.log("Serial port selected", "success");
      return this.port;
    } catch (error) {
      this.log(`Error selecting port: ${error.message}`, "error");
      throw error;
    }
  }

  async connectPort() {
    try {
      await this.port.open({
        baudRate: this.RF_CONFIG.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
      });

      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
      this.abortController = new AbortController();

      await this.sleep(1000);
      this.log(
        `Connected to serial port at ${this.RF_CONFIG.baudRate} baud`,
        "success"
      );
      this.updateConnectionStatus(true);
    } catch (error) {
      this.log(`Connection error: ${error.message}`, "error");
      this.updateConnectionStatus(false);
      throw error;
    }
  }

  updateConnectionStatus(connected) {
    const indicator = document.querySelector(".status-indicator");
    const statusText = document.querySelector(".status-text");
    if (indicator && statusText) {
      indicator.className = `status-indicator ${connected ? "connected" : ""}`;
      statusText.textContent = connected ? "Connected" : "Disconnected";
    }
  }

  hexToUint8Array(hexString) {
    if (!hexString || hexString.length % 2 !== 0) return new Uint8Array();
    return new Uint8Array(
      hexString.match(/.{1,2}/g).map((byte) => parseInt(byte, 16))
    );
  }

  extractHexData(dataString) {
    try {
      const matches = dataString.match(/RX "([0-9A-Fa-f]+)"/g);
      if (!matches) return "";

      const result = matches
        .map((m) => {
          const inner = m.match(/RX "([0-9A-Fa-f]+)"/);
          return inner && inner[1] ? inner[1] : "";
        })
        .filter((hex) => hex)
        .join("");

      this.log(`Found ${matches.length} RX patterns`, "info");
      return result;
    } catch (error) {
      this.log(`Error extracting hex data: ${error.message}`, "error");
      return "";
    }
  }

  createMissMessage(missingChunks) {
    const totalSize = 6 + missingChunks.length * 2;
    const buffer = new ArrayBuffer(totalSize);
    const uint8View = new Uint8Array(buffer);
    const dataView = new DataView(buffer);

    // Set "MISS" header
    uint8View[0] = 77; // 'M'
    uint8View[1] = 73; // 'I'
    uint8View[2] = 83; // 'S'
    uint8View[3] = 83; // 'S'

    // Set number of missing chunks
    dataView.setUint16(4, missingChunks.length, false);

    // Set sequence numbers
    missingChunks.forEach((seq, index) => {
      dataView.setUint16(6 + index * 2, seq, false);
    });

    return uint8View;
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async readUntilNewline() {
    if (!this.reader) {
      throw new Error("Reader not initialized");
    }

    let buffer = "";
    while (true) {
      const { value, done } = await this.reader.read();
      if (done) {
        throw new Error("Reader stream closed");
      }

      const chunk = new TextDecoder().decode(value);
      this.log(`Raw chunk received: "${chunk}"`, "info");
      buffer += chunk;

      // Only process complete packets terminated by \r\n
      if (buffer.includes("\r\n")) {
        const lines = buffer.split("\r\n");
        // Keep the last partial line in the buffer
        buffer = lines.pop() || "";
        const completeLines = lines.join("\r\n");
        this.log(`Complete packet received: "${completeLines}"`, "info");
        return completeLines;
      }
    }
  }

  async sendCommand(command) {
    try {
      if (!this.writer) {
        throw new Error("Writer not initialized");
      }

      // Send command - encode as UTF-8 bytes
      const encoder = new TextEncoder();
      await this.writer.write(encoder.encode(command));
      this.log(`Sent command: ${command.trim()}`);

      // Read response - wait for complete packet
      let response = await this.readUntilNewline();
      this.log(`Raw response: "${response}"`);

      // Only fail on ERROR response
      if (response.includes("ERROR")) {
        throw new Error(`Command failed: ${response}`);
      }

      return true;
    } catch (error) {
      this.log(`Error sending command: ${error.message}`);
      throw error;
    }
  }

  updateConfigFromUI() {
    const frequencyEl = document.getElementById("configFrequency");
    const sfEl = document.getElementById("configSF");
    const bwEl = document.getElementById("configBW");
    const powerEl = document.getElementById("configPower");
    const verboseEl = document.getElementById("configVerbose");

    if (frequencyEl) this.RF_CONFIG.frequency = parseInt(frequencyEl.value, 10);
    if (sfEl) this.RF_CONFIG.spreadingFactor = parseInt(sfEl.value, 10);
    if (bwEl) this.RF_CONFIG.bandwidth = parseInt(bwEl.value, 10);
    if (powerEl) this.RF_CONFIG.powerDbm = parseInt(powerEl.value, 10);
    if (verboseEl) this.VERBOSE = verboseEl.checked;

    this.log(
      `Configuration updated: Freq=${this.RF_CONFIG.frequency}MHz, SF=${this.RF_CONFIG.spreadingFactor}, BW=${this.RF_CONFIG.bandwidth}kHz, Power=${this.RF_CONFIG.powerDbm}dBm, Verbose=${this.VERBOSE}`,
      "info"
    );
  }

  async launchServer() {
    try {
      this.port = await this.requestPort();
      await this.connectPort();

      // Reset state
      this.buffer = new Uint8Array();
      this.incomingBytes = 0;
      this.width = 0;
      this.height = 0;
      this.startTime = null;
      this.chunksReceived = {};
      this.bytesReceived = 0;
      this.numExpectedChunks = null;
      this.missingChunks = new Set();

      // Configure if needed
      if (this.configureCheckbox && this.configureCheckbox.checked) {
        this.log("Sending configuration", "info");
        const configCommands = this.getConfigCommands();

        for (const cmd of configCommands.split("\n")) {
          await this.sendCommand(`${cmd}\n`);
          await this.sleep(500);
        }
        this.log("Server configured", "success");
      }

      // Start listening
      this.log("Sending RXLRPKT command...", "info");
      await this.sendCommand(this.AT_RXLRPKT);
      this.log("Listening...", "info");

      while (
        this.incomingBytes === 0 ||
        this.bytesReceived < this.incomingBytes
      ) {
        let buffer = "";
        let hexData = "";
        let isCollectingHex = false;

        while (true) {
          const { value, done } = await this.reader.read();
          if (done) {
            throw new Error("Reader stream closed");
          }

          const chunk = new TextDecoder().decode(value);
          buffer += chunk;

          // Look for RX " pattern
          if (!isCollectingHex && buffer.includes('RX "')) {
            isCollectingHex = true;
            const startIndex = buffer.indexOf('RX "') + 4;
            buffer = buffer.slice(startIndex);
          }

          // If we're collecting hex data, look for the closing quote
          if (isCollectingHex && buffer.includes('"')) {
            const endIndex = buffer.indexOf('"');
            hexData += buffer.slice(0, endIndex);
            buffer = buffer.slice(endIndex + 1);
            isCollectingHex = false;
            break;
          } else if (isCollectingHex) {
            hexData += buffer;
            buffer = "";
          }
        }

        if (!hexData) continue;

        let chunkBytes = new Uint8Array(
          hexData.match(/.{1,2}/g).map((byte) => parseInt(byte, 16))
        );

        // Handle header packet
        if (
          this.incomingBytes === 0 &&
          chunkBytes.length >= this.PROTOCOL_HEADER_SIZE
        ) {
          const headerData = chunkBytes.slice(0, this.PROTOCOL_HEADER_SIZE);
          const preamble = new TextDecoder().decode(headerData.slice(0, 4));

          if (preamble !== "LORA") {
            this.log("Received invalid preamble, dropping packet", "error");
            this.incomingBytes = 0;
            continue;
          }

          const dataView = new DataView(headerData.buffer);
          this.incomingBytes = dataView.getUint32(4, false);
          this.width = dataView.getUint32(8, false);
          this.height = dataView.getUint32(12, false);
          this.numExpectedChunks = Math.ceil(
            this.incomingBytes / this.CHUNK_SIZE
          );

          this.log("LORA", "success");
          this.log(`Detected ${this.width}x${this.height} image`, "info");
          this.log(`Receiving ${this.incomingBytes} bytes`, "info");

          this.startTime = performance.now();
          this.updateProgress(0, this.incomingBytes); // Initialize progress bar
          chunkBytes = chunkBytes.slice(this.PROTOCOL_HEADER_SIZE);
        }

        // Handle data chunk
        if (chunkBytes.length > 2) {
          const seqNumber = new DataView(chunkBytes.buffer).getUint16(0, false);
          const payload = chunkBytes.slice(2);

          // Update last chunk time
          this.lastChunkTime = performance.now();

          // Validate sequence number - only check if it's within valid range
          if (seqNumber >= this.numExpectedChunks) {
            this.log(
              `Invalid sequence number ${seqNumber}, expected < ${this.numExpectedChunks}`,
              "error"
            );
            continue;
          }

          // Handle duplicate chunks gracefully
          if (this.chunksReceived[seqNumber]) {
            this.log(`Received duplicate chunk ${seqNumber}, ignoring`, "info");
            continue;
          }

          // Store the chunk
          this.chunksReceived[seqNumber] = payload;
          this.bytesReceived += payload.length;
          this.log(
            `Received chunk ${seqNumber} (${payload.length} bytes)`,
            "info"
          );
          this.updateProgress(this.bytesReceived, this.incomingBytes);

          // Check for missing chunks periodically
          if (
            this.bytesReceived > 0 &&
            performance.now() - this.lastChunkTime > this.CHUNK_TIMEOUT
          ) {
            this.checkAndRequestMissingChunks();
          }
        }

        // Check for timeout and handle retransmission
        if (
          this.incomingBytes > 0 &&
          performance.now() - this.startTime > this.RETRANSMISSION_TIMEOUT
        ) {
          await this.checkAndRequestMissingChunks();
        }
      }

      // Acknowledge successfully receiving all packets
      await this.sleep(this.RX_SWITCH_DELAY);
      for (let i = 0; i < 3; i++) {
        const missMessage = this.createMissMessage([]);
        await this.sendCommand(
          `AT+TEST=TXLRPKT, "${missMessage.toString("hex")}"\n`
        );
        await this.sleep(1000);
      }
      this.log("Confirmation sent (3x)", "success");

      const duration = (performance.now() - this.startTime) / 1000;
      const bytesPerSecond = Math.round(this.incomingBytes / duration);

      // Sort and assemble buffer from received chunks
      const sortedChunks = Object.entries(this.chunksReceived)
        .sort(([a], [b]) => parseInt(a) - parseInt(b))
        .map(([_, chunk]) => chunk);

      const imageBuffer = new Uint8Array(this.incomingBytes);
      let offset = 0;
      for (const chunk of sortedChunks) {
        imageBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      this.log(
        `Received ${this.bytesReceived} bytes over ${
          Object.keys(this.chunksReceived).length
        } segments in ${duration.toFixed(3)}s (${bytesPerSecond}) bytes/s`,
        "info"
      );

      this.displayImage(imageBuffer);
      this.saveImageToFile(imageBuffer, "bytes.bin");
      this.log(`Saved ${this.incomingBytes} bytes to "bytes.bin"`, "success");
    } catch (error) {
      this.log(`Server error: ${error.message}`, "error");
    } finally {
      await this.stopReception();
    }
  }

  async checkAndRequestMissingChunks() {
    // Update missing chunks set
    this.missingChunks = new Set(
      Array.from({ length: this.numExpectedChunks }, (_, i) => i).filter(
        (i) => !this.chunksReceived[i]
      )
    );

    if (this.missingChunks.size > 0) {
      this.log(
        `Missing ${this.missingChunks.size} chunks: ${Array.from(
          this.missingChunks
        ).join(", ")}`,
        "error"
      );
      await this.requestRetransmission(Array.from(this.missingChunks));
    } else {
      this.log("All chunks received successfully", "success");
    }
  }

  async requestRetransmission(missingChunks) {
    if (missingChunks.length === 0) return;

    this.log(
      `Requesting retransmission of ${missingChunks.length} chunks...`,
      "info"
    );
    await this.sleep(this.RX_SWITCH_DELAY);

    // Split missing chunks into groups of 10 to avoid message size limits
    const chunkGroups = [];
    for (let i = 0; i < missingChunks.length; i += 10) {
      chunkGroups.push(missingChunks.slice(i, i + 10));
    }

    for (const group of chunkGroups) {
      const missMessage = this.createMissMessage(group);
      await this.sendCommand(
        `AT+TEST=TXLRPKT, "${missMessage.toString("hex")}"\n`
      );
      await this.sleep(1000);
    }

    await this.sendCommand(this.AT_RXLRPKT);
    this.lastChunkTime = performance.now(); // Reset the chunk timeout
  }

  displayImage(buffer) {
    try {
      const blob = new Blob([buffer], { type: "image/jpeg" });
      const imageUrl = URL.createObjectURL(blob);

      if (this.imgElement) {
        this.imgElement.src = imageUrl;
        this.imgElement.style.display = "block";
      }

      this.log("Image displayed successfully", "success");
      this.saveImageToFile(buffer, "received_image.jpg");
    } catch (error) {
      this.log(`Error displaying image: ${error.message}`, "error");
    }
  }

  saveImageToFile(buffer, filename) {
    const blob = new Blob([buffer], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.textContent = `Download ${filename}`;
    link.className = "download-link";

    const downloadContainer = document.getElementById("downloadContainer");
    if (downloadContainer) {
      downloadContainer.innerHTML = "";
      downloadContainer.appendChild(link);
    }

    link.click();
  }

  async stopReception() {
    if (!this.isReceiving) return;

    this.isReceiving = false;
    if (this.abortController) {
      this.abortController.abort();
    }

    try {
      if (this.reader) {
        await this.reader.cancel();
        if (this.readableStreamClosed) {
          try {
            await this.readableStreamClosed;
          } catch (e) {
            // Ignore stream closure errors
          }
        }
        this.reader = null;
      }

      if (this.writer) {
        await this.writer.close();
        if (this.writableStreamClosed) {
          try {
            await this.writableStreamClosed;
          } catch (e) {
            // Ignore stream closure errors
          }
        }
        this.writer = null;
      }

      if (this.port && this.port.isOpen) {
        await this.port.close();
      }

      if (this.port) {
        await this.port.releaseLock();
      }

      this.log("Reception stopped", "info");
      this.updateConnectionStatus(false);
    } catch (error) {
      this.log(`Error during cleanup: ${error.message}`, "error");
      this.updateConnectionStatus(false);
    }
  }

  async startGroundStation() {
    try {
      this.isReceiving = true;
      await this.launchServer();
    } catch (error) {
      this.log(`Ground station error: ${error.message}`, "error");
    } finally {
      await this.stopReception();
    }
  }

  async configureDevice() {
    try {
      if (!this.writer) {
        throw new Error("No connection established");
      }

      this.log("Starting device configuration...", "info");
      const configCommands = this.getConfigCommands();

      for (const cmd of configCommands.split("\n")) {
        await this.sendCommand(`${cmd}\n`);
        await this.sleep(500);
      }

      this.log("Device configuration completed successfully", "success");
      return true;
    } catch (error) {
      this.log(`Configuration failed: ${error.message}`, "error");
      return false;
    }
  }

  getConfigCommands() {
    return `AT+LOG=${this.VERBOSE ? "DEBUG" : "QUIET"}
AT+UART=BR,${this.RF_CONFIG.baudRate}
AT+MODE=TEST
AT+TEST=RFCFG,${this.RF_CONFIG.frequency},SF${this.RF_CONFIG.spreadingFactor},${
      this.RF_CONFIG.bandwidth
    },12,15,${this.RF_CONFIG.powerDbm},ON,OFF,OFF`;
  }
}

// Initialize when the page is loaded
document.addEventListener("DOMContentLoaded", () => {
  const groundStation = new GroundStation();

  // Set up button event listeners
  const startButton = document.getElementById("startReception");
  const stopButton = document.getElementById("stopReception");
  const advancedToggle = document.getElementById("advancedToggle");
  const advancedSettings = document.getElementById("advancedSettings");

  if (startButton) {
    startButton.addEventListener("click", () => {
      groundStation.startGroundStation();
    });
  }

  if (stopButton) {
    stopButton.addEventListener("click", () => {
      groundStation.stopReception();
      startButton.disabled = false;
      stopButton.disabled = true;
    });
  }

  // Set up advanced settings toggle
  if (advancedToggle && advancedSettings) {
    advancedToggle.addEventListener("click", () => {
      advancedSettings.style.display =
        advancedSettings.style.display === "none" ? "block" : "none";
      advancedToggle.textContent =
        advancedSettings.style.display === "none"
          ? "Show Advanced Settings"
          : "Hide Advanced Settings";
    });
  }

  // Initialize advanced settings display
  if (advancedSettings) {
    advancedSettings.style.display = "none";
  }
});
