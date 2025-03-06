// LoRa Ground Station using Browser Web Serial API
class GroundStation {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readableStreamClosed = null;
    this.writableStreamClosed = null;
    this.isReceiving = false;
    this.abortController = null;
    
    // Display elements
    this.logElement = document.getElementById('log');
    this.imgElement = document.getElementById('receivedImage');
    this.progressBar = document.getElementById('progressBar');
    this.progressText = document.getElementById('progressText');
    this.configureCheckbox = document.getElementById('configureDevice');
    
    // Constants (matching Python implementation)
    this.PROTOCOL_HEADER_SIZE = 16;
    this.CHUNK_SIZE = 200; // Match the Python client's chunk size
    this.RF_CONFIG = {
      baudRate: 230400, // Match baudrate with Python client
      frequency: 868,   // MHz
      spreadingFactor: 7,
      bandwidth: 250,   // kHz
      powerDbm: 14      // Transmit power
    };
    this.AT_RXLRPKT = "AT+TEST=RXLRPKT\n";
    this.RX_SWITCH_DELAY = 500; // ms delay for mode switching
    this.RETRANSMISSION_TIMEOUT = 10000; // ms - matches Python's 10 second timeout
    this.VERBOSE = true;
  }

  log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = type === 'error' ? '[-] ' : 
                   type === 'success' ? '[+] ' : '[*] ';
    console[type === 'error' ? 'error' : 'log'](`${prefix}${message}`);

    if (this.logElement) {
      const entry = document.createElement('div');
      entry.className = `log-${type}`;
      entry.textContent = `${timestamp}: ${prefix}${message}`;
      this.logElement.appendChild(entry);
      this.logElement.scrollTop = this.logElement.scrollHeight;
    }
  }

  updateProgress(received, total) {
    const percent = total > 0 ? Math.round((received / total) * 100) : 0;
    if (this.progressBar) {
      this.progressBar.value = percent;
      this.progressBar.style.width = `${percent}%`;
    }
    if (this.progressText) {
      this.progressText.textContent = `${percent}% (${received}/${total} bytes)`;
    }
  }

  async requestPort() {
    try {
      this.port = await navigator.serial.requestPort();
      this.log('Serial port selected', 'success');
      return this.port;
    } catch (error) {
      this.log(`Error selecting port: ${error.message}`, 'error');
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
      this.log(`Connected to serial port at ${this.RF_CONFIG.baudRate} baud`, 'success');
    } catch (error) {
      this.log(`Connection error: ${error.message}`, 'error');
      throw error;
    }
  }

  // Convert hex string to Uint8Array
  hexToUint8Array(hexString) {
    if (!hexString || hexString.length % 2 !== 0) return new Uint8Array();
    
    return new Uint8Array(
      hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16))
    );
  }

  // Extract hex data from RX messages
  extractHexData(dataString) {
    const matches = dataString.match(/RX "([0-9A-Fa-f]+)"/g);
    if (!matches) return '';
    
    return matches
      .map(m => m.match(/RX "([0-9A-Fa-f]+)"/)[1])
      .join('');
  }

  // Create a MISS message for retransmission requests
  createMissMessage(missingChunks) {
    // Format: MISS + number of missing chunks (2 bytes) + sequence numbers (2 bytes each)
    const buffer = new ArrayBuffer(4 + missingChunks.length * 2);
    const view = new DataView(buffer);
    
    // Set the MISS header
    const encoder = new TextEncoder();
    const missHeader = encoder.encode('MISS');
    new Uint8Array(buffer, 0, 4).set(missHeader);
    
    // Set the number of missing chunks (2 bytes)
    view.setUint16(4, missingChunks.length, false); // big-endian
    
    // Set the sequence numbers (2 bytes each)
    missingChunks.forEach((seq, index) => {
      view.setUint16(6 + index * 2, seq, false); // big-endian
    });
    
    return new Uint8Array(buffer);
  }

  // Wait for a specific delay
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Send AT command and return response
  async sendCommand(command) {
    if (!this.writer) return null;
    
    await this.writer.write(new TextEncoder().encode(command));
    this.log(`Sent: ${command.trim()}`, 'info');
    
    // No need to wait for response here, it will be processed in the read loop
    return true;
  }
  
  // Update configuration from UI elements
  updateConfigFromUI() {
    // Only update if elements exist
    const frequencyEl = document.getElementById('configFrequency');
    const sfEl = document.getElementById('configSF');
    const bwEl = document.getElementById('configBW');
    const powerEl = document.getElementById('configPower');
    const verboseEl = document.getElementById('configVerbose');
    
    if (frequencyEl) this.RF_CONFIG.frequency = parseInt(frequencyEl.value, 10);
    if (sfEl) this.RF_CONFIG.spreadingFactor = parseInt(sfEl.value, 10);
    if (bwEl) this.RF_CONFIG.bandwidth = parseInt(bwEl.value, 10);
    if (powerEl) this.RF_CONFIG.powerDbm = parseInt(powerEl.value, 10);
    if (verboseEl) this.VERBOSE = verboseEl.checked;
    
    this.log(`Configuration updated: Freq=${this.RF_CONFIG.frequency}MHz, SF=${this.RF_CONFIG.spreadingFactor}, BW=${this.RF_CONFIG.bandwidth}kHz, Power=${this.RF_CONFIG.powerDbm}dBm, Verbose=${this.VERBOSE}`, 'info');
  }

  // Request retransmission of missing chunks
  async requestRetransmission(missingChunks) {
    if (missingChunks.length === 0) {
      this.log('No missing chunks to request', 'success');
      return;
    }
    
    // Switch to TX mode temporarily
    this.log(`Requesting retransmission of ${missingChunks.length} chunks: ${missingChunks.join(', ')}`, 'info');
    
    await this.sleep(this.RX_SWITCH_DELAY);
    
    const missPayload = this.createMissMessage(missingChunks);
    const hexPayload = Array.from(missPayload)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
      
    await this.sendCommand(`AT+TEST=TXLRPKT, "${hexPayload}"\n`);
    
    // Wait for TX DONE response
    await this.sleep(1000);
    
    // Switch back to RX mode
    await this.sendCommand(this.AT_RXLRPKT);
  }

  // Display the received image
  displayImage(buffer) {
    try {
      const blob = new Blob([buffer], { type: 'image/jpeg' });
      const imageUrl = URL.createObjectURL(blob);
      
      // Display image if the element exists
      if (this.imgElement) {
        this.imgElement.src = imageUrl;
        this.imgElement.style.display = 'block';
      }
      
      this.log('Image displayed successfully', 'success');
      
      // Also provide a download link
      this.saveImageToFile(buffer, "received_image.jpg");
    } catch (error) {
      this.log(`Error displaying image: ${error.message}`, 'error');
    }
  }

  // Save the image buffer to a file
  saveImageToFile(buffer, filename) {
    const blob = new Blob([buffer], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.textContent = `Download ${filename}`;
    link.className = 'download-link';
    
    // Add the link to the page
    const downloadContainer = document.getElementById('downloadContainer');
    if (downloadContainer) {
      downloadContainer.innerHTML = '';
      downloadContainer.appendChild(link);
    }
    
    // Auto-download
    link.click();
  }

  // Stop the reception process
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
    
    this.log('Reception stopped', 'info');
  }

  // Main function to receive the image
  async receiveImage() {
    if (this.isReceiving) {
      this.log('Already receiving an image', 'error');
      return;
    }
    
    this.isReceiving = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    
    let buffer = new Uint8Array();
    let incomingBytes = 0;
    let width = 0;
    let height = 0;
    let chunksReceived = {};
    let bytesReceived = 0;
    let numExpectedChunks = 0;
    const startTime = performance.now();
    
    try {
      // Set up streams
      const textDecoder = new TextDecoder();
      const textEncoder = new TextEncoder();
      
      this.readableStreamClosed = this.port.readable.pipeTo(
        new WritableStream({
          write: async (chunk) => {
            if (signal.aborted) return;
            
            const dataString = textDecoder.decode(chunk);
            this.log(`Received: ${dataString.trim()}`, 'info');
            
            const hexData = this.extractHexData(dataString);
            if (!hexData) return;
            
            const chunkData = this.hexToUint8Array(hexData);
            if (!chunkData.length) return;
            
            // Process first chunk with header
            if (incomingBytes === 0 && chunkData.length >= this.PROTOCOL_HEADER_SIZE) {
              const headerData = chunkData.slice(0, this.PROTOCOL_HEADER_SIZE);
              const preamble = textDecoder.decode(headerData.slice(0, 4));
              
              if (preamble !== 'LORA') {
                this.log('Invalid preamble, dropping packet', 'error');
                return;
              }
              
              const dataView = new DataView(headerData.buffer);
              incomingBytes = dataView.getUint32(4, false); // big-endian
              width = dataView.getUint32(8, false);
              height = dataView.getUint32(12, false);
              
              this.log(`Detected ${width}x${height} image`, 'success');
              this.log(`Receiving ${incomingBytes} bytes`, 'info');
              
              numExpectedChunks = Math.ceil(incomingBytes / this.CHUNK_SIZE);
              this.log(`Expecting ${numExpectedChunks} chunks`, 'info');
              
              // Process payload after header if any
              const payloadAfterHeader = chunkData.slice(this.PROTOCOL_HEADER_SIZE);
              if (payloadAfterHeader.length > 2) {
                const seqNumberView = new DataView(payloadAfterHeader.buffer, 
                  payloadAfterHeader.byteOffset, 2);
                const seqNumber = seqNumberView.getUint16(0, false); // big-endian
                const chunkPayload = payloadAfterHeader.slice(2);
                
                if (seqNumber >= 0 && seqNumber < numExpectedChunks) {
                  chunksReceived[seqNumber] = chunkPayload;
                  bytesReceived += chunkPayload.length;
                  this.updateProgress(bytesReceived, incomingBytes);
                }
              }
            } 
            // Process regular chunk
            else if (incomingBytes > 0 && chunkData.length > 2) {
              const seqNumberView = new DataView(chunkData.buffer, chunkData.byteOffset, 2);
              const seqNumber = seqNumberView.getUint16(0, false); // big-endian
              const chunkPayload = chunkData.slice(2);
              
              // Validate sequence number
              if (seqNumber >= 0 && seqNumber < numExpectedChunks) {
                if (!chunksReceived[seqNumber]) {
                  chunksReceived[seqNumber] = chunkPayload;
                  bytesReceived += chunkPayload.length;
                  this.log(`Received chunk ${seqNumber}, total bytes: ${bytesReceived}`, 'info');
                  this.updateProgress(bytesReceived, incomingBytes);
                }
              }
            }
            
            // Check if we need to request missing chunks
            if (incomingBytes > 0 && Object.keys(chunksReceived).length > 0) {
              // Every 3 seconds or so, check for missing chunks
              const elapsed = performance.now() - startTime;
              if (elapsed > this.RETRANSMISSION_TIMEOUT && bytesReceived < incomingBytes) {
                // Find missing chunks
                const missingChunks = [];
                for (let i = 0; i < numExpectedChunks; i++) {
                  if (!chunksReceived[i]) {
                    missingChunks.push(i);
                  }
                }
                
                if (missingChunks.length > 0) {
                  await this.requestRetransmission(missingChunks);
                }
              }
              
              // If we've received all chunks, reassemble and display
              if (Object.keys(chunksReceived).length === numExpectedChunks || 
                 bytesReceived >= incomingBytes) {
                this.log('All chunks received', 'success');
                
                // Reassemble the image
                const sortedChunks = Object.keys(chunksReceived)
                  .map(Number)
                  .sort((a, b) => a - b)
                  .map(key => chunksReceived[key]);
                
                const imageBuffer = new Uint8Array(
                  sortedChunks.reduce((acc, chunk) => {
                    const newArray = new Uint8Array(acc.length + chunk.length);
                    newArray.set(acc);
                    newArray.set(chunk, acc.length);
                    return newArray;
                  }, new Uint8Array(0))
                );
                
                const duration = (performance.now() - startTime) / 1000;
                this.log(
                  `Received ${bytesReceived} bytes in ${duration.toFixed(3)}s`,
                  'success'
                );
                
                // Display the image
                this.displayImage(imageBuffer);
                
                // Send final confirmation (3 times)
                await this.sleep(this.RX_SWITCH_DELAY);
                for (let i = 0; i < 3; i++) {
                  await this.requestRetransmission([]);
                  await this.sleep(1000);
                }
                
                this.log('Reception complete!', 'success');
                await this.stopReception();
              }
            }
          }
        }),
        { signal }
      ).catch(error => {
        if (error.name !== 'AbortError') {
          this.log(`Stream error: ${error.message}`, 'error');
        }
      });
      
      // Set up writer
      this.writer = this.port.writable.getWriter();
      this.writableStreamClosed = new Promise(resolve => {
        signal.addEventListener('abort', () => {
          this.writer.close().then(resolve);
        });
      });
      
      // Start reception
      await this.sendCommand(this.AT_RXLRPKT);
      this.log('Listening for transmission...', 'info');
      
    } catch (error) {
      this.log(`Reception error: ${error.message}`, 'error');
      await this.stopReception();
    }
  }

  // Device configuration sequence
  async configureDevice() {
    if (!this.writer) {
      this.log('Cannot configure: No connection established', 'error');
      return false;
    }
    
    this.log('Starting device configuration...', 'info');
    
    const commands = [
      `AT+LOG=${this.VERBOSE ? 'DEBUG' : 'QUIET'}\n`,
      `AT+UART=BR, ${this.RF_CONFIG.baudRate}\n`,
      `AT+MODE=TEST\n`,
      `AT+TEST=RFCFG,${this.RF_CONFIG.frequency},SF${this.RF_CONFIG.spreadingFactor},${this.RF_CONFIG.bandwidth},12,15,${this.RF_CONFIG.powerDbm},ON,OFF,OFF\n`
    ];
    
    try {
      for (const cmd of commands) {
        await this.sendCommand(cmd);
        // We need to pause briefly between commands to allow the device to process
        await this.sleep(200);
      }
      
      this.log('Device configuration completed successfully', 'success');
      return true;
    } catch (error) {
      this.log(`Configuration failed: ${error.message}`, 'error');
      return false;
    }
  }

  // Main entry point
  async startGroundStation() {
    try {
      // First make sure Web Serial API is available
      if (!navigator.serial) {
        this.log('Web Serial API is not supported in this browser', 'error');
        return;
      }
      
      await this.requestPort();
      await this.connectPort();
      
      // Update configuration from UI and configure device if option is checked
      this.updateConfigFromUI();
      if (this.configureCheckbox && this.configureCheckbox.checked) {
        await this.configureDevice();
      }
      
      // Get button references
      const startButton = document.getElementById('startReception');
      const stopButton = document.getElementById('stopReception');
      
      if (startButton) {
        startButton.disabled = true;
      }
      if (stopButton) {
        stopButton.disabled = false;
      }
      
      // Start image reception
      await this.receiveImage();
      
    } catch (error) {
      this.log(`Ground station error: ${error.message}`, 'error');
      
      const startButton = document.getElementById('startReception');
      const stopButton = document.getElementById('stopReception');
      
      if (startButton) {
        startButton.disabled = false;
      }
      if (stopButton) {
        stopButton.disabled = true;
      }
    }
  }
}

// Initialize when the page is loaded
document.addEventListener('DOMContentLoaded', () => {
  const groundStation = new GroundStation();
  
  // Set up button event listeners
  const startButton = document.getElementById('startReception');
  const stopButton = document.getElementById('stopReception');
  const advancedToggle = document.getElementById('advancedToggle');
  const advancedSettings = document.getElementById('advancedSettings');
  
  if (startButton) {
    startButton.addEventListener('click', () => {
      groundStation.startGroundStation();
    });
  }
  
  if (stopButton) {
    stopButton.addEventListener('click', () => {
      groundStation.stopReception();
      startButton.disabled = false;
      stopButton.disabled = true;
    });
  }
  
  // Set up advanced settings toggle
  if (advancedToggle && advancedSettings) {
    advancedToggle.addEventListener('click', () => {
      advancedSettings.style.display = 
        advancedSettings.style.display === 'none' ? 'block' : 'none';
      advancedToggle.textContent = 
        advancedSettings.style.display === 'none' ? 'Show Advanced Settings' : 'Hide Advanced Settings';
    });
  }
  
  // Initialize advanced settings display
  if (advancedSettings) {
    advancedSettings.style.display = 'none';
  }
});
