// Serial Communication Example using Browser Serial API
class SerialImageReceiver {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;

    // Constants
    this.PROTOCOL_HEADER_SIZE = 16;
    this.CHUNK_SIZE = 256;
    this.RF_CONFIG = {
      baudRate: 9600,
    };
    this.AT_RXLRPKT = "AT+TEST=RXLRPKT";
    this.RX_SWITCH_DELAY = 500; // ms
    this.RETRANSMISSION_TIMEOUT = 5000; // ms
    this.VERBOSE = true;
  }

  async requestPort() {
    try {
      // Request the serial port with optional filters
      this.port = await navigator.serial.requestPort({
        filters: [
          // You can add specific vendor/product IDs if needed
          // { usbVendorId: 0x2341, usbProductId: 0x0043 }
        ],
      });

      console.log("[+] Serial port selected");
      return this.port;
    } catch (error) {
      console.error("[-] Error selecting port:", error);
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
      console.log(`[+] Connected to serial port`);
    } catch (error) {
      console.error("[-] Connection error:", error);
      throw error;
    }
  }

  async receiveImage() {
    let buffer = new Uint8Array();
    let incomingBytes = 0;
    let width = 0;
    let height = 0;
    let chunksReceived = {};
    let bytesReceived = 0;
    let numExpectedChunks = 0;
    let missingChunks = new Set();
    const startTime = performance.now();

    try {
      // Create a reader and writer for the serial port
      const reader = this.port.readable.getReader();
      const writer = this.port.writable.getWriter();

      // Send initial receive command
      await writer.write(new TextEncoder().encode(`${this.AT_RXLRPKT}\n`));

      while (incomingBytes === 0 || bytesReceived < incomingBytes) {
        const { value, done } = await reader.read();

        if (done) break;

        if (value) {
          // Process received data
          const dataString = new TextDecoder().decode(value);
          const matches = dataString.match(/RX "(\w+)"/g);

          if (matches) {
            const chunkBytes = matches
              .map((m) => m.match(/RX "(\w+)"/)[1])
              .join("");

            const chunkData = this.hexToUint8Array(chunkBytes);

            // First chunk processing (header)
            if (incomingBytes === 0 && chunkData.length > 0) {
              const headerData = chunkData.slice(0, this.PROTOCOL_HEADER_SIZE);
              const preamble = new TextDecoder().decode(headerData.slice(0, 4));

              if (preamble !== "LORA") {
                console.log("Invalid preamble, dropping packet");
                continue;
              }

              // Extract image details
              const dataView = new DataView(headerData.buffer);
              incomingBytes = dataView.getUint32(4, true);
              width = dataView.getUint32(8, true);
              height = dataView.getUint32(12, true);

              console.log(`[*] Detected ${width}x${height} image`);
              console.log(`[*] Receiving ${incomingBytes} bytes`);

              numExpectedChunks = Math.ceil(incomingBytes / this.CHUNK_SIZE);
            }

            // Process chunk data
            if (chunkData.length > 2) {
              const seqNumberView = new DataView(chunkData.slice(0, 2).buffer);
              const seqNumber = seqNumberView.getUint16(0, true);
              const chunkPayload = chunkData.slice(2);

              // Validate sequence number
              if (seqNumber >= 0 && seqNumber < numExpectedChunks) {
                if (!chunksReceived[seqNumber]) {
                  chunksReceived[seqNumber] = chunkPayload;
                  bytesReceived += chunkPayload.length + 2;
                  console.log(`[*] Received ${bytesReceived} bytes`);
                }
              }
            }
          }
        }
      }

      // Reassemble and save image
      const sortedChunks = Object.keys(chunksReceived)
        .sort((a, b) => a - b)
        .map((key) => chunksReceived[key]);

      buffer = new Uint8Array(
        sortedChunks.reduce((acc, chunk) => [...acc, ...chunk], [])
      );

      const duration = (performance.now() - startTime) / 1000;
      console.log(
        `[*] Received ${bytesReceived} bytes in ${duration.toFixed(3)}s`
      );

      // Save image to file (browser version)
      this.saveImageToFile(buffer, "received_image.bin");

      reader.releaseLock();
      writer.releaseLock();
      await this.port.close();
    } catch (error) {
      console.error("Error receiving image:", error);
    }
  }

  hexToUint8Array(hexString) {
    return new Uint8Array(
      hexString.match(/.{1,2}/g).map((byte) => parseInt(byte, 16))
    );
  }

  saveImageToFile(buffer, filename) {
    const blob = new Blob([buffer], { type: "application/octet-stream" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async startImageReception() {
    try {
      await this.requestPort();
      await this.connectPort();
      await this.receiveImage();
    } catch (error) {
      console.error("Image reception failed:", error);
    }
  }
}

// Usage example
async function main() {
  const serialReceiver = new SerialImageReceiver();
  await serialReceiver.startImageReception();
}

// Call main when a button is clicked or at an appropriate time
document.getElementById("startReception").addEventListener("click", main);
