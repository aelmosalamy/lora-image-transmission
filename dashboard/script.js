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

    // Constants
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
    this.RX_SWITCH_DELAY = 500;
    this.RETRANSMISSION_TIMEOUT = 10000;
    this.VERBOSE = true;

    // Reception state
    this.receptionState = {
      incomingBytes: 0,
      width: 0,
      height: 0,
      chunksReceived: new Map(),
      bytesReceived: 0,
      startTime: null,
      numExpectedChunks: 0,
    };
  }

  log(message, type = "info") {
    const timestamp = new Date().toLocaleTimeString();
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
      this.logElement.scrollTop = this.logElement.scrollHeight;
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
    return new Promise((resolve, reject) => {
      if (!navigator.serial) {
        reject(new Error("Web Serial API is not supported in this browser"));
        return;
      }

      // Create port selection dialog
      const dialog = document.createElement("div");
      dialog.className = "port-selection-dialog";
      dialog.innerHTML = `
                <div class="dialog-content">
                    <h3>Select Serial Port</h3>
                    <p>Please select the LoRa module's serial port:</p>
                    <div class="port-list"></div>
                    <div class="dialog-buttons">
                        <button id="refreshPorts">Refresh</button>
                        <button id="cancelPort">Cancel</button>
                    </div>
                </div>
            `;
      document.body.appendChild(dialog);

      // Function to update port list
      const updatePortList = async () => {
        const portList = dialog.querySelector(".port-list");
        portList.innerHTML = "";

        try {
          const ports = await navigator.serial.getPorts();
          if (ports.length === 0) {
            portList.innerHTML =
              "<p>No ports available. Please connect a device.</p>";
            return;
          }

          ports.forEach((port) => {
            const button = document.createElement("button");
            button.textContent = `Port ${port.getInfo().usbVendorId}:${
              port.getInfo().usbProductId
            }`;
            button.onclick = () => {
              document.body.removeChild(dialog);
              resolve(port);
            };
            portList.appendChild(button);
          });
        } catch (error) {
          portList.innerHTML = `<p>Error: ${error.message}</p>`;
        }
      };

      // Set up event listeners
      dialog.querySelector("#refreshPorts").onclick = updatePortList;
      dialog.querySelector("#cancelPort").onclick = () => {
        document.body.removeChild(dialog);
        reject(new Error("Port selection cancelled"));
      };

      // Initial port list update
      updatePortList();
    });
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
    try {
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

      this.log(
        `Created MISS message for ${missingChunks.length} chunks`,
        "info"
      );
      return uint8View;
    } catch (error) {
      this.log(`Error creating MISS message: ${error.message}`, "error");
      return new Uint8Array([77, 73, 83, 83, 0, 0]);
    }
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async sendCommand(command) {
    if (!this.writer) return null;
    await this.writer.write(new TextEncoder().encode(command));
    this.log(`Sent: ${command.trim()}`, "info");
    await this.sleep(300);
    return true;
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

  async requestRetransmission(missingChunks) {
    if (missingChunks.length === 0) return;

    await this.sleep(this.RX_SWITCH_DELAY);
    const missMessage = this.createMissMessage(missingChunks);
    await this.sendCommand(
      `AT+TEST=TXLRPKT, "${missMessage.toString("hex")}"\n`
    );
    await this.sleep(1000);
    await this.sendCommand(this.AT_RXLRPKT);
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

    if (this.reader) {
      await this.reader.cancel();
      await this.readableStreamClosed.catch(() => {});
      this.reader = null;
    }

    if (this.writer) {
      await this.writer.close();
      await this.writableStreamClosed.catch(() => {});
      this.writer = null;
    }

    if (this.port && this.port.isOpen) {
      await this.port.close();
    }

    this.log("Reception stopped", "info");
    this.updateConnectionStatus(false);
  }

  async processChunkData(chunkData, state) {
    if (!chunkData) {
      this.log("Received null chunk data", "error");
      return state;
    }

    this.log(`Processing chunk data of length ${chunkData.length}`, "info");
    const { incomingBytes, chunksReceived, numExpectedChunks } = state;

    // Handle header chunk
    if (incomingBytes === 0 && chunkData.length >= this.PROTOCOL_HEADER_SIZE) {
      const headerData = chunkData.slice(0, this.PROTOCOL_HEADER_SIZE);
      const preamble = new TextDecoder().decode(headerData.slice(0, 4));

      if (preamble !== "LORA") {
        this.log("Invalid preamble, dropping packet", "error");
        return state;
      }

      const dataView = new DataView(headerData.buffer);
      const incomingBytes = dataView.getUint32(4, false);
      const width = dataView.getUint32(8, false);
      const height = dataView.getUint32(12, false);
      const numExpectedChunks = Math.ceil(incomingBytes / this.CHUNK_SIZE);

      this.log(`LORA preamble detected`, "success");
      this.log(`Image dimensions: ${width}x${height}`, "info");
      this.log(`Total bytes to receive: ${incomingBytes}`, "info");
      this.log(`Expected chunks: ${numExpectedChunks}`, "info");

      const newState = {
        ...state,
        incomingBytes,
        width,
        height,
        startTime: performance.now(),
        numExpectedChunks,
      };
      return newState;
    }

    // Handle data chunk
    if (incomingBytes > 0 && chunkData.length > 2) {
      const seqNumber = new DataView(chunkData.buffer).getUint16(0, false);
      const payload = chunkData.slice(2);

      if (!chunksReceived[seqNumber]) {
        const newBytesReceived = state.bytesReceived + chunkData.length;
        this.log(
          `Received chunk ${seqNumber}, length ${chunkData.length}, total bytes: ${newBytesReceived}`,
          "info"
        );

        return {
          ...state,
          chunksReceived: {
            ...chunksReceived,
            [seqNumber]: payload,
          },
          bytesReceived: newBytesReceived,
        };
      }
    }

    return state;
  }

  async readSerialData() {
    if (!this.reader) {
      throw new Error("Serial reader not initialized");
    }

    try {
      const { value, done } = await this.reader.read();
      if (done) return null;

      const rawData = new TextDecoder().decode(value);
      this.log(`Raw data received: ${rawData.trim()}`, "info");
      const lines = rawData.split("\r\n");

      for (const line of lines) {
        if (line.startsWith("RX ")) {
          const match = line.match(/RX "([0-9A-Fa-f]+)"/);
          if (match && match[1]) {
            const hexData = match[1];
            this.log(`Found hex data: ${hexData}`, "info");
            const uint8Data = this.hexToUint8Array(hexData);
            if (uint8Data.length > 0) {
              this.log(`Converted to ${uint8Data.length} bytes`, "info");
              return uint8Data;
            }
          }
        }
      }
      return null;
    } catch (error) {
      this.log(`Error reading serial data: ${error.message}`, "error");
      return null;
    }
  }

  findMissingChunks(state) {
    const missing = [];
    for (let i = 0; i < state.numExpectedChunks; i++) {
      if (!state.chunksReceived[i]) {
        missing.push(i);
      }
    }
    return missing;
  }

  async assembleAndDisplayImage(state) {
    try {
      const sortedChunks = Object.entries(state.chunksReceived)
        .sort(([a], [b]) => parseInt(a) - parseInt(b))
        .map(([_, chunk]) => chunk);

      const imageBuffer = new Uint8Array(state.incomingBytes);
      let offset = 0;

      for (const chunk of sortedChunks) {
        imageBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      const duration = (performance.now() - state.startTime) / 1000;
      const bytesPerSecond = Math.round(state.incomingBytes / duration);

      this.log(
        `Reception completed in ${duration.toFixed(
          2
        )}s (${bytesPerSecond} bytes/s)`,
        "success"
      );
      this.displayImage(imageBuffer);
    } catch (error) {
      this.log(`Error assembling image: ${error.message}`, "error");
    }
  }

  async receiveImage() {
    if (this.isReceiving) return;

    try {
      this.isReceiving = true;

      this.writableStreamClosed = new Promise((resolve) => {
        this.abortController.signal.addEventListener("abort", () => {
          if (this.writer) {
            this.writer.close().then(resolve);
          } else {
            resolve();
          }
        });
      });

      let state = {
        incomingBytes: 0,
        width: 0,
        height: 0,
        chunksReceived: {},
        bytesReceived: 0,
        startTime: null,
        numExpectedChunks: 0,
      };

      await this.sendCommand(this.AT_RXLRPKT);
      this.log("Listening for transmission...", "info");

      while (this.isReceiving) {
        const data = await this.readSerialData();
        if (!data) {
          await this.sleep(100);
          continue;
        }

        state = await this.processChunkData(data, state);

        if (state.incomingBytes > 0) {
          this.updateProgress(state.bytesReceived, state.incomingBytes);

          if (
            Object.keys(state.chunksReceived).length === state.numExpectedChunks
          ) {
            const missing = this.findMissingChunks(state);
            if (missing.length === 0) {
              await this.assembleAndDisplayImage(state);
              break;
            }
            await this.requestRetransmission(missing);
          }
        }
      }
    } catch (error) {
      this.log(`Reception error: ${error.message}`, "error");
    } finally {
      await this.stopReception();
    }
  }

  async configureDevice() {
    try {
      if (!this.writer) {
        throw new Error("No connection established");
      }
      return false;
    } catch (error) {
      this.log(error.message, "error");
    }

    this.log("Starting device configuration...", "info");

    const commands = [
      `AT+LOG=${this.VERBOSE ? "DEBUG" : "QUIET"}\n`,
      `AT+UART=BR,${this.RF_CONFIG.baudRate}\n`,
      `AT+MODE=TEST\n`,
      `AT+TEST=RFCFG,${this.RF_CONFIG.frequency},SF${this.RF_CONFIG.spreadingFactor},${this.RF_CONFIG.bandwidth},12,15,${this.RF_CONFIG.powerDbm},ON,OFF,OFF\n`,
    ];

    try {
      for (const cmd of commands) {
        await this.sendCommand(cmd);
        await this.sleep(200);
      }

      this.log("Device configuration completed successfully", "success");
      return true;
    } catch (error) {
      this.log(`Configuration failed: ${error.message}`, "error");
      return false;
    }
  }

  async startGroundStation() {
    try {
      this.port = await this.requestPort();
      await this.connectPort();

      this.updateConfigFromUI();
      if (this.configureCheckbox && this.configureCheckbox.checked) {
        await this.configureDevice();
      }

      const startButton = document.getElementById("startReception");
      const stopButton = document.getElementById("stopReception");

      if (startButton) startButton.disabled = true;
      if (stopButton) stopButton.disabled = false;

      await this.sendCommand("AT\n");
      await this.sleep(500);

      await this.receiveImage();
    } catch (error) {
      this.log(`Ground station error: ${error.message}`, "error");

      const startButton = document.getElementById("startReception");
      const stopButton = document.getElementById("stopReception");

      if (startButton) startButton.disabled = false;
      if (stopButton) stopButton.disabled = true;
    }
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
