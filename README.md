# lora-image-transmission

Python serial controller to provide image transmission between two LoRa-enabled MCUs. The project is split into two files:

- `ground.py`: This represents our ground station, continuously listening for any image broadcasts.
- `main.py`: This represents our drone transmitter, it has a basic Tkinter GUI that allows us to connect, upload and transmit an image.

A bit about the serial protocol: This project makes use of AT commands supported by Seeed STM32WLE5JC boards and uses a prefix to signal image dimensions to the ground station before transmission.
