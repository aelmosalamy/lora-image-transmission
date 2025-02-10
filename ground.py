import serial
import argparse
import time
import struct
import re
from PIL import Image

ENABLE_LOG = False
PROTOCOL_HEADER_SIZE = 12

# AT+TEST=RFCFG,868,SF6,250,12,15,14,ON,OFF,OFF
# Available baud rate are 9600 14400 19200 38400 57600 76800 115200 and 230400

# To change baudrate, first modify it using UART here, then RST the device physically
# Next start it will be available at the COM port with the desired baudrate.
ground_config = f'''\
AT+LOG={'DEBUG' if ENABLE_LOG else 'QUIET'}
AT+UART=BR, 230400
AT+MODE=TEST
AT+TEST=RFCFG,868,SF7,500,12,15,14,ON,OFF,OFF
AT+TEST=RXLRPKT'''.encode()


def args():
    parser = argparse.ArgumentParser()


    args = parser.parse_args()
    

def connect_ground(port="COM4"):
    buffer = b''
    width, height, incoming_bytes = 0, 0, 0
    start_time = None

    try:
        with serial.Serial(port=port, baudrate=230400, bytesize=8, parity="N", stopbits=1, timeout=1) as ser_ground:
            if ser_ground.is_open:
                print(f"[+] Connected to {port}.")

            print("[*] Configuring ground")
            for cmd in ground_config.split(b'\n'):
                r = ser_ground.write(cmd + b'\n')
                time.sleep(0.3)

            r = ser_ground.readall()
            print(f'<<< {r.decode()}')

            packets_received = 0
            print('[*] Listening...')
            while incoming_bytes == 0 or len(buffer) < incoming_bytes:
                if r := ser_ground.read_until(b'\r\n'):
                    if m := re.finditer(r'RX "(\w+?)"', r.decode()):
                        b = bytes.fromhex(''.join([x.group(1) for x in m]))

                        if incoming_bytes == 0 and b:
                            start_time = time.perf_counter_ns()
                            incoming_bytes, width, height = struct.unpack('>III', b[:PROTOCOL_HEADER_SIZE])
                            print(f'[*] Detected {width}x{height} image.')
                            print(f'[*] Receiving {incoming_bytes} bytes.')
                            b = b[PROTOCOL_HEADER_SIZE:]

                        packets_received += 1
                        buffer += b
                        if b and len(buffer) % (incoming_bytes // 10) < 5:
                            print(f'[*] Received {len(buffer)} bytes')

                    if ENABLE_LOG:
                        print(f"<<< {r}")
            
            duration_ns = time.perf_counter_ns() - start_time
            print(f'[*] Received {len(buffer)} bytes over {packets_received} segments')
            print(f'[+] Received {incoming_bytes} bytes in {duration_ns / 10**9:.3f}s')

            with open('bytes.bin', 'wb') as f:
                f.write(buffer)
                image = Image.frombytes('RGB', (width,height), buffer, 'raw')
                image.show()

            print(f'[+] Written {incoming_bytes} bytes to "bytes.bin"')

    except FileNotFoundError:
        print(f"[-] Connection to {port} failed.")


if __name__ == '__main__':
    connect_ground()
