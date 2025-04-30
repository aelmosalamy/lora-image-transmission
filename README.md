# lora-image-transmission

This project enables the transmission of images between two LoRa-enabled MCUs. It uses a serial communication protocol based on AT commands to handle image data transmission. The system consists of two main components: a ground station and a drone transmitter. The ground station continuously listens for incoming image data, while the drone transmitter uploads and transmits the image using a basic Tkinter GUI.

The project is split into two primary sections:

- **Python Serial Controller:**
  - `lora.py`: A CLI prototyping tool containing both server and client.
  - `dashboard/`: A friendly user interface for ground station operators to view received images including GPS coordinates.
  
- **C/C++ LoRa Communication:**
  - This version of the project handles image transmission over a LoRa network using AT commands. It divides a raw image into chunks, sends them, and retransmits any lost data based on acknowledgments from the receiver.

## Features

- Transmits images using AT commands over LoRa.
- Sends image metadata as a header, including the width, height, and total bytes.
- Divides images into fixed-size chunks (default: 200 bytes per chunk).
- Retransmits only the missing chunks, ensuring reliability.
- Provides debug logging, controlled via macros.
- Can run on both Arduino and non-Arduino platforms for simulation or real-world use.

## Communication Protocol

The image data is transmitted in chunks, each with a 2-byte sequence number. The ground station listens for the image dimensions before receiving the chunks. The protocol also includes retransmission of any missing chunks.

### Header Format
Before the image data is transmitted, the following header is sent to the ground station to provide necessary image information (16 bytes in total):

```
+--------+----------+-------------+--------------+
| "LORA" | DataSize | ImageWidth  | ImageHeight  |
+--------+----------+-------------+--------------+
|  4 B   |   4 B    |    4 B      |     4 B      |
+--------+----------+-------------+--------------+
```

- `"LORA"`: A fixed string identifying the transmission type.
- `DataSize`: The total size of the image data (including headers and sequence numbers).
- `ImageWidth` and `ImageHeight`: The dimensions of the image.

### Chunk Transmission

Each chunk of the image is sent with a 2-byte sequence number. The first chunk has sequence number `0`, and the last chunk has `NUM_OF_CHUNKS - 1`. After transmission, the ground station checks for missing chunks and sends a request for retransmission.

### Retransmission Request

If any chunks are missing, the receiver will send a request for retransmission in the following format:

===
MISS<N><SEQ_1><SEQ_2>...<SEQ_N>
===

Where:
- `N`: The number of missing chunks.
- `<SEQ_i>`: The 2-byte sequence number of each missing chunk.

## Acknowledgments

Special thanks to Ahmad AlSaleh (@Ahmad-Alsaleh) for writing an [embedded C version](https://github.com/Ahmad-Alsaleh/Drone-Wireless-Communication) of this project for deployment on an ESP32 C3.
