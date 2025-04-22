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
    this.transferStartTime = null;
    this.lastChunkTime = null;

    // Display elements
    this.logElement = document.getElementById("log");
    this.imgElement = document.getElementById("receivedImage");
    this.progressBar = document.getElementById("progressBar");
    this.progressText = document.getElementById("progressText");
    this.configureCheckbox = document.getElementById("configureDevice");

    // Constants matching lora.py
    this.PROTOCOL_HEADER_SIZE = 16;
    this.CHUNK_SIZE = 202;
    this.RF_CONFIG = {
      baudRate: 230400,
      frequency: 868,
      spreadingFactor: 7,
      bandwidth: 250,
      powerDbm: 14,
    };
    this.AT_RXLRPKT = "AT+TEST=RXLRPKT\n";
    this.RETRANSMISSION_TIMEOUT = 10000; // Increased to 10 seconds
    this.RX_SWITCH_DELAY = 500;
    this.VERBOSE = false;
    this.lastChunkTime = 0;
    this.lastSeqNumber = -1; // Track last sequence number
    this.outOfOrderChunks = new Map(); // Store out-of-order chunks

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
      tx: ">>> ",
      rx: "<<< ",
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
    const usbVendorId = 0x10c4;
    const usbProductId = 0xea60;

    if (!navigator.serial) {
      throw new Error("Web Serial API is not supported in this browser");
    }

    try {
      // we filter for the Silicon Labs CP210x UART Bridge Udevice
      if (!this.port) {
        this.port = await navigator.serial.requestPort({
          filters: [{ usbVendorId, usbProductId }],
        });
      }
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
    uint8View[0] = 0x4d; // 'M'
    uint8View[1] = 0x49; // 'I'
    uint8View[2] = 0x53; // 'S'
    uint8View[3] = 0x53; // 'S'

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

  async readWithTimeout(ms) {
    while (true) {
      console.log('[*] Reading...') 
      const readPromise = this.reader.read()

      const timeoutPromise = new Promise(
        (resolve) =>
          (this._readTimer = setTimeout(() => resolve("timeout"), ms))
      );

      const result = await Promise.race([readPromise, timeoutPromise]);

      if (result === "timeout") {
        this.reader.cancel()
        console.log('Timed out. Canceled reader')
        clearTimeout(this._readTimer); // safety
        await this.checkAndRequestMissingChunks();
        continue; // immediately try reading again
      }

      clearTimeout(this._readTimer);
      const { value, done } = result

      // our stream got canceled (proven by non-existing value and bytes not complete)
      if (done && this.bytesReceived < this.incomingBytes) {
        this.reader = this.port.readable.getReader()
      } else {
        return result; // { value, done }
      }
    }
  }

  async readUntilNewline() {
    if (!this.reader) {
      throw new Error("Reader not initialized");
    }

    let buffer = "";
    while (true) {
      // we could have also used the stream async iterable protocol here, but will keep it like this for parity with the Python version
      const { value, done } = await this.readWithTimeout(
        this.RETRANSMISSION_TIMEOUT
      );

      const chunk = new TextDecoder().decode(value);
      buffer += chunk;

      // Only process complete packets terminated by \r\n
      if (buffer.includes("\r\n")) {
        const lines = buffer.split("\r\n");
        // Keep the last partial line in the buffer
        buffer = lines.pop() || "";
        const completeLines = lines.join("\r\n");
        // this.log(`Complete packet received: "${completeLines}"`, "info");
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
      this.log(`Sent command: ${command.trim()}`, "tx");

      // Read response - wait for complete packet
      let response = await this.readUntilNewline();
      this.log(`Got response: "${response}"`, "rx");

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
    const freq868El = document.getElementById("freq868");
    const freq915El = document.getElementById("freq915");
    const sfEl = document.getElementById("configSF");
    const bwEl = document.getElementById("configBW");
    const powerEl = document.getElementById("configPower");
    const verboseEl = document.getElementById("configVerbose");

    // Get frequency from radio buttons
    if (freq868El && freq868El.checked) {
      this.RF_CONFIG.frequency = 868;
    } else if (freq915El && freq915El.checked) {
      this.RF_CONFIG.frequency = 915;
    }

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
      this.updateProgress(0, 0);

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
          const { value, done } = await this.readWithTimeout(
            this.RETRANSMISSION_TIMEOUT
          );
          if (done) {
            throw new Error("Reader stream closed 1");
          }

          this.startTime = performance.now();
          const chunk = new TextDecoder().decode(value);
          buffer += chunk;

          // Refresh timeout since we received a valid chunk
          if (chunk) {
            this.lastChunkTime = performance.now();
          }

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
          const dataView = new DataView(headerData.buffer);

          if (preamble === 'LORA') {
            this.incomingBytes = dataView.getUint32(4, false);
            this.width = dataView.getUint32(8, false);
            this.height = dataView.getUint32(12, false);
            this.numExpectedChunks = Math.ceil(
              this.incomingBytes / this.CHUNK_SIZE
            );

            this.transferStartTime = performance.now();
            this.lastChunkTime = this.transferStartTime;

            this.log("LORA: Incoming image!", "success");
            this.log(`Detected ${this.width}x${this.height} image`, "info");
            this.log(`Receiving ${this.incomingBytes} bytes`, "info");

            this.updateProgress(0, this.incomingBytes);
            chunkBytes = chunkBytes.slice(this.PROTOCOL_HEADER_SIZE);
          } else if (preamble === 'CORD') {
            handleCoordinates(chunkBytes.slice(4))
            continue
          } else {
            this.log("Received invalid preamble/cord header, dropping packet", "error");
            this.incomingBytes = 0;
            continue;
          }
        }

        // Handle data chunk
        if (chunkBytes.length > 2) {
          const seqNumber = new DataView(chunkBytes.buffer).getUint16(0, false);
          const payload = chunkBytes.slice(2);

          // Update last chunk time
          this.lastChunkTime = performance.now();

          // Validate sequence number
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
          this.bytesReceived += chunkBytes.length;
          this.lastSeqNumber = Math.max(this.lastSeqNumber, seqNumber);
          console.log(`Received chunk ${seqNumber} (${payload.length} bytes)`);
          this.updateProgress(this.bytesReceived, this.incomingBytes);

          // Process any out-of-order chunks that can now be processed
          this.processOutOfOrderChunks();
        }

        // Check for timeout and handle retransmission
        if (
          this.incomingBytes > 0 &&
          performance.now() - this.startTime > this.RETRANSMISSION_TIMEOUT
        ) {
          await this.checkAndRequestMissingChunks();
        }
      }

      const duration = (performance.now() - this.startTime) / 1000;
      const bytesPerSecond = Math.round(this.incomingBytes / duration);

      // Sort and assemble received chunks based on sequence number
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
        } segments in ${duration.toFixed(3)}s (${bytesPerSecond} bytes/s)`,
        "info"
      );

      this.displayImage(imageBuffer);
      this.saveImageToFile(imageBuffer, "bytes.bin");
      this.log(`Saved ${this.incomingBytes} bytes to "bytes.bin"`, "success");

      // Acknowledge successfully receiving all packets
      await this.sleep(this.RX_SWITCH_DELAY);
      for (let i = 0; i < 3; i++) {
        const missMessageBytes = this.createMissMessage([]);
        const missMessage = [...missMessageBytes]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        window.m = missMessageBytes;
        window.k = missMessage;
        await this.sendCommand(`AT+TEST=TXLRPKT, "${missMessage}"\n`);
        // interval confirmation with exponential backoff
        await this.sleep(1000 * 2 ** i);
      }
      this.log("Confirmation sent (3x)", "success");
    } catch (error) {
      this.log(`Server error: ${error.message}`, "error");
    } finally {
      await this.stopReception();
    }
  }

  processOutOfOrderChunks() {
    // Process any chunks that can now be processed in sequence
    let processed = true;
    while (processed) {
      processed = false;
      for (const [seq, chunk] of this.outOfOrderChunks.entries()) {
        if (seq === this.lastSeqNumber + 1) {
          this.chunksReceived[seq] = chunk;
          this.bytesReceived += chunk.length;
          this.lastSeqNumber = seq;
          this.outOfOrderChunks.delete(seq);
          this.log(`Processed out-of-order chunk ${seq}`, "info");
          processed = true;
        }
      }
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
        "warning"
      );
      await this.requestRetransmission(Array.from(this.missingChunks));
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
      const hexMissMessage = Array.from(missMessage)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      await this.sendCommand(`AT+TEST=TXLRPKT, "${hexMissMessage}"\n`);
      await this.sleep(100);
    }

    await this.sendCommand(this.AT_RXLRPKT);
    this.lastChunkTime = performance.now(); // Reset the chunk timeout
  }

  displayImage(buffer) {
    try {
      // convert the received image from base64 to hex
      const decoder = new TextDecoder();
      const text = decoder.decode(buffer);
      const imageUrl = "data:image/jpeg;base64," + text;
      console.log(`text: ${text}`);

      if (this.imgElement) {
        this.imgElement.src = imageUrl;
        this.imgElement.style.display = "block";

        // Apply default image display class if not already set
        if (
          !this.imgElement.classList.contains("image-original") &&
          !this.imgElement.classList.contains("image-fill")
        ) {
          this.imgElement.classList.add("image-original");
        }
      }

      this.log("Image displayed successfully", "success");
      this.saveImageToFile(buffer, "received_image.jpg");

      // For demonstration, update drone position each time an image is received
      // In a real application, you would extract GPS data from the transmission
      this.updateDronePosition();
    } catch (error) {
      this.log(`Error displaying image: ${error.message}`, "error");
    }
  }

  updateDronePosition() {
    // Simulate random movement within ~0.01 degrees of default position
    // In a real application, you would extract GPS data from the transmission
    const randomLat = DEFAULT_LAT + (Math.random() - 0.5) * 0.02;
    const randomLng = DEFAULT_LNG + (Math.random() - 0.5) * 0.02;

    // Update the map marker
    if (typeof updateDronePosition === "function") {
      updateDronePosition(randomLat, randomLng);
      this.log(
        `Updated drone position: ${randomLat.toFixed(6)}, ${randomLng.toFixed(
          6
        )}`,
        "info"
      );
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

    // link.click();
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
            this.log(`Read stream closed with error: ${e}`, "error");
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
            this.log(`Write stream closed with error: ${e}`, "error");
          }
        }
        this.writer = null;
      }

      if (this.port && this.port.connected) {
        await this.port.close();
      }

      this.log("Reception stopped", "info");
      // this.
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
  AT+TEST=RFCFG,${this.RF_CONFIG.frequency},SF${
      this.RF_CONFIG.spreadingFactor
    },${this.RF_CONFIG.bandwidth},12,15,${this.RF_CONFIG.powerDbm},ON,OFF,OFF`;
  }
}

// Google Maps variables
let map;
let marker;
let path;
const DEFAULT_LAT = 25.348766;
const DEFAULT_LNG = 55.405403;
let currentMarkerPosition = { lat: DEFAULT_LAT, lng: DEFAULT_LNG };
let pathCoordinates = [];

// Initialize when the page is loaded
document.addEventListener("DOMContentLoaded", () => {
  const groundStation = new GroundStation();
  window.groundStation = groundStation;

  // Set up button event listeners
  const startButton = document.getElementById("startReception");
  const stopButton = document.getElementById("stopReception");
  const advancedToggle = document.getElementById("advancedToggle");
  const imageToggle = document.getElementById("imageToggle");
  const viewToggle = document.getElementById("viewToggle");
  const receivedImage = document.getElementById("receivedImage");
  const viewTitle = document.getElementById("viewTitle");

  // Initialize Google Maps
  initMap();

  // Initialize view containers
  const imageView = document.getElementById("imageView");
  const mapView = document.getElementById("mapView");

  // Set initial view state
  if (imageView) imageView.style.display = "flex";
  if (mapView) mapView.style.display = "none";

  // Setup view toggle functionality
  if (viewToggle) {
    viewToggle.addEventListener("click", () => {
      const imageView = document.getElementById("imageView");
      const mapView = document.getElementById("mapView");

      console.log("Toggling view between image and map");

      if (imageView.style.display === "none") {
        // Switch to image view
        console.log("Switching to image view");
        imageView.style.display = "flex";
        mapView.style.display = "none";
        viewTitle.textContent = "Received Image";

        // Show image toggle only in image view
        if (imageToggle) imageToggle.style.display = "flex";
      } else {
        // Switch to map view
        console.log("Switching to map view");
        imageView.style.display = "none";
        mapView.style.display = "block";
        viewTitle.textContent = "Drone Location";

        // Hide image toggle in map view
        if (imageToggle) imageToggle.style.display = "none";

        // Force map to appear by triggering resize and re-centering
        setTimeout(() => {
          if (map) {
            console.log("Triggering map resize");
            google.maps.event.trigger(map, "resize");

            if (marker) {
              map.setCenter(marker.getPosition());
            } else {
              map.setCenter(new google.maps.LatLng(DEFAULT_LAT, DEFAULT_LNG));
            }
          }
        }, 100);
      }
    });
  }

  // Setup reload map button
  const reloadMapBtn = document.getElementById("reloadMap");
  if (reloadMapBtn) {
    reloadMapBtn.addEventListener("click", () => {
      console.log("Manually reloading map");
      initMap();

      // Switch to map view if not already there
      const imageView = document.getElementById("imageView");
      const mapView = document.getElementById("mapView");

      if (imageView.style.display !== "none") {
        imageView.style.display = "none";
        mapView.style.display = "block";

        if (viewTitle) viewTitle.textContent = "Drone Location";
        if (imageToggle) imageToggle.style.display = "none";
      }
    });
  }

  // Setup image toggle functionality
  if (imageToggle && receivedImage) {
    imageToggle.addEventListener("click", () => {
      if (receivedImage.classList.contains("image-fill")) {
        receivedImage.classList.remove("image-fill");
        receivedImage.classList.add("image-original");
        imageToggle.title = "Fill frame";
      } else {
        receivedImage.classList.remove("image-original");
        receivedImage.classList.add("image-fill");
        imageToggle.title = "Original size";
      }
    });

    // Default to contain mode
    receivedImage.classList.add("image-fill");
  }

  if (startButton) {
    startButton.addEventListener("click", () => {
      startButton.disabled = true;
      stopButton.disabled = false;
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

  // Modal controls
  const modal = document.getElementById("settingsModal");
  const closeModalBtn = document.querySelector(".close-modal");
  const saveSettingsBtn = document.getElementById("saveSettings");

  // Setup modal toggle
  if (advancedToggle) {
    advancedToggle.addEventListener("click", () => {
      modal.style.display = "block";
    });
  }

  // Close modal when clicking X
  if (closeModalBtn) {
    closeModalBtn.addEventListener("click", () => {
      modal.style.display = "none";
    });
  }

  // Save settings
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener("click", () => {
      groundStation.updateConfigFromUI();
      modal.style.display = "none";
    });
  }

  // Close modal when clicking outside
  window.addEventListener("click", (event) => {
    if (event.target === modal) {
      modal.style.display = "none";
    }
  });
});

// Initialize Google Maps
function initMap() {
  console.log("Initializing Google Maps...");

  // Check if Maps API is already loaded
  if (window.google && window.google.maps) {
    console.log("Google Maps API already loaded, initializing map...");
    initializeMapObjects();
    return;
  }

  // Create a script element to load Google Maps API
  const script = document.createElement("script");
  // Use Google Maps with no API key (development mode)
  script.src = `https://maps.googleapis.com/maps/api/js?callback=onMapApiLoaded`;
  script.async = true;
  script.defer = true;

  // Add error handling
  script.onerror = function () {
    console.error("Failed to load Google Maps API");
    document.getElementById("map").innerHTML =
      '<div style="padding: 20px; text-align: center; color: #ef4444;">Failed to load Google Maps</div>';
  };

  document.head.appendChild(script);

  // Create a global callback function for the API to call when loaded
  window.onMapApiLoaded = function () {
    console.log("Google Maps API loaded successfully");
    initializeMapObjects();
  };
}

function initializeMapObjects() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: DEFAULT_LAT, lng: DEFAULT_LNG },
    zoom: 14,
    mapTypeId: google.maps.MapTypeId.TERRAIN,
    styles: [
      { elementType: "geometry", stylers: [{ color: "#242f3e" }] },
      {
        elementType: "labels.text.stroke",
        stylers: [{ color: "#242f3e" }],
      },
      {
        elementType: "labels.text.fill",
        stylers: [{ color: "#746855" }],
      },
      {
        featureType: "administrative.locality",
        elementType: "labels.text.fill",
        stylers: [{ color: "#d59563" }],
      },
      {
        featureType: "poi",
        elementType: "labels.text.fill",
        stylers: [{ color: "#d59563" }],
      },
      {
        featureType: "poi.park",
        elementType: "geometry",
        stylers: [{ color: "#263c3f" }],
      },
      {
        featureType: "poi.park",
        elementType: "labels.text.fill",
        stylers: [{ color: "#6b9a76" }],
      },
      {
        featureType: "road",
        elementType: "geometry",
        stylers: [{ color: "#38414e" }],
      },
      {
        featureType: "road",
        elementType: "geometry.stroke",
        stylers: [{ color: "#212a37" }],
      },
      {
        featureType: "road",
        elementType: "labels.text.fill",
        stylers: [{ color: "#9ca5b3" }],
      },
      {
        featureType: "road.highway",
        elementType: "geometry",
        stylers: [{ color: "#746855" }],
      },
      {
        featureType: "road.highway",
        elementType: "geometry.stroke",
        stylers: [{ color: "#1f2835" }],
      },
      {
        featureType: "road.highway",
        elementType: "labels.text.fill",
        stylers: [{ color: "#f3d19c" }],
      },
      {
        featureType: "transit",
        elementType: "geometry",
        stylers: [{ color: "#2f3948" }],
      },
      {
        featureType: "transit.station",
        elementType: "labels.text.fill",
        stylers: [{ color: "#d59563" }],
      },
      {
        featureType: "water",
        elementType: "geometry",
        stylers: [{ color: "#17263c" }],
      },
      {
        featureType: "water",
        elementType: "labels.text.fill",
        stylers: [{ color: "#515c6d" }],
      },
      {
        featureType: "water",
        elementType: "labels.text.stroke",
        stylers: [{ color: "#17263c" }],
      },
    ],
  });

  // Create a path for the drone's trail
  pathCoordinates.push({ lat: DEFAULT_LAT, lng: DEFAULT_LNG });
  path = new google.maps.Polyline({
    path: pathCoordinates,
    geodesic: true,
    strokeColor: "#60a5fa",
    strokeOpacity: 0.7,
    strokeWeight: 3,
  });
  path.setMap(map);

  // Add a marker
  marker = new google.maps.Marker({
    position: { lat: DEFAULT_LAT, lng: DEFAULT_LNG },
    map: map,
    title: "Drone location",
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 12,
      fillColor: "#60a5fa",
      fillOpacity: 0.9,
      strokeColor: "#ffffff",
      strokeWeight: 3,
    },
    animation: google.maps.Animation.DROP,
  });

  console.log("Map and marker initialized successfully");
}

// Update drone position on the map
function updateDronePosition(lat, lng) {
  if (!map || !marker) return;

  const position = { lat, lng };
  marker.setPosition(position);
  map.panTo(position);
  currentMarkerPosition = position;

  // Add to path trail
  pathCoordinates.push(position);
  if (path) {
    path.setPath(pathCoordinates);

    // Limit trail length to 20 points
    if (pathCoordinates.length > 20) {
      pathCoordinates.shift();
    }
  }
}

function handleCoordinates(coordinateBytes) {
  const coordinates = new TextDecoder().decode(coordinateBytes) 
  lat, lng = coordinates.split(',')
  updateDronePosition(lat, lng)
}
