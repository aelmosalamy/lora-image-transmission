#!/usr/bin/env python3
from serial.tools import list_ports
from tkinter import filedialog
from PIL import Image, ImageTk
from datetime import datetime
from random import random
from serial import Serial
from io import BytesIO
import tkinter as tk
import threading
import argparse
import struct
import time
import os
import re

VERBOSE = ...

# AT+TEST=RFCFG,868,SF6,250,12,15,14,ON,OFF,OFF
# Available baud rate are 9600 14400 19200 38400 57600 76800 115200 and 230400
# To change baudrate, first modify it using UART here, then RST the device physically
# Next start it will be available at the COM port with the desired baudrate.
RF_CONFIG = {
    'baudrate': 230400,
    'frequency': 868,
    'spreading_factor': 7,
    'bandwidth': 250,
    'power_dbm': 14
}

PROTOCOL_HEADER_SIZE = 16

AT_RXLRPKT = 'AT+TEST=RXLRPKT\n'

CHUNK_SIZE = 200

RETRANSMISSION_TIMEOUT = 10

# magic delay based on observation to give enough time for the other transceiver
# to switch to RX
RX_SWITCH_DELAY = 0.5

# to be refactored
status_text_box: tk.Text = None

def get_config_commands():
    global VERBOSE

    commands = f'''\
AT+LOG={'DEBUG' if VERBOSE else 'QUIET'}
AT+UART=BR, {RF_CONFIG['baudrate']}
AT+MODE=TEST
AT+TEST=RFCFG,{RF_CONFIG['frequency']},SF{RF_CONFIG['spreading_factor']},{RF_CONFIG['bandwidth']},12,15,{RF_CONFIG['power_dbm']},ON,OFF,OFF
'''

    return commands

def spreading_factor_type(arg):
    MIN_VAL, MAX_VAL = 6, 14

    try:
        sf = int(arg)
    except ValueError:    
        raise argparse.ArgumentTypeError("invalid spreading factor")
    if sf < MIN_VAL or sf > MAX_VAL:
        raise argparse.ArgumentTypeError(f"spreading factor must be between {MAX_VAL} and {MIN_VAL}")
    
    return sf

def dbm_type(arg):
    MIN_VAL, MAX_VAL = 13, 22

    try:
        dbm = int(arg)
    except ValueError:    
        raise argparse.ArgumentTypeError("invalid spreading factor")
    if dbm < MIN_VAL or dbm > MAX_VAL:
        raise argparse.ArgumentTypeError(f"spreading factor must be between {MAX_VAL} and {MIN_VAL}")
    
    return dbm

def com_port_type(arg):
    if type(arg) is str:
        return arg
    
    raise argparse.ArgumentTypeError("invalid COM port specified, must match COMx")
 
def get_args():
    parser = argparse.ArgumentParser()

    subparsers = parser.add_subparsers(dest='mode', required=True)
    server_parser = subparsers.add_parser('server', help='launch the lora server (ground station)')
    client_parser = subparsers.add_parser('client', help='launch the lora client interface')

    # shared arguments
    for p in (server_parser, client_parser):
        p.add_argument('--port', '-p', help='specify serial COM port name',
                type=com_port_type)
        p.add_argument('--configure', '-c', help='apply default configuration', action='store_true')
        p.add_argument('--sf', type=spreading_factor_type, help='pick spreading factor', default=7)
        p.add_argument('--dbm', type=dbm_type, help='pick transceiver power in dBm', default=14)
        p.add_argument('--bandwidth', '--bw', type=int, choices=(250, 500), help='pick signal bandwidth', default=250)
        p.add_argument('--verbose', '-v', help='verbose mode', action='store_true')

    client_parser.add_argument('--auto', action=argparse.BooleanOptionalAction, help='automatically connect upon launch', default=False)

    return parser.parse_args()

def timestamp() -> str:
    return datetime.now().strftime("%H:%M:%S")

def scan_com_ports():
    available_ports = []
    for port in list_ports.comports():
        available_ports.append((port.device, port.description))
    return available_ports

def print(*args, **kwargs):
    if status_text_box:
        status_text_box.insert(
            tk.END, f"{timestamp()}: {' '.join(str(_) for _ in args)} \n"
        )
        status_text_box.yview_moveto(1)

    __builtins__.print(*args, **kwargs)

def launch_server(port='COM4', configure=False):
    buffer = b''
    incoming_bytes = width = height = 0
    start_time = None

    try:
        with Serial(port, baudrate=RF_CONFIG['baudrate'], bytesize=8, parity="N", stopbits=1, timeout=1) as ser_ground:
            if ser_ground.is_open:
                print(f"[+] Server connected to serial port ({port})")

            if configure:
                print('[*] Sending configuration')

                ground_config = get_config_commands()
                if VERBOSE:
                    print('>>>', '\n>>> '.join(ground_config.strip().split('\n')), end='\n\n')

                for cmd in ground_config.split('\n'):
                    ser_ground.write(f'{cmd}\n'.encode())

                    # get AT config acknowledgement & check for errors
                    r = ser_ground.readline()

                    if b'ERROR' in r:
                        print(f"[!] Configuration error: {r.decode()}")
                        exit(1)
                    if r:
                        print('<<<', r.decode(), end='')


                print('[+] Server configured')

            ser_ground.write(f'{AT_RXLRPKT}\n'.encode())
            r = ser_ground.readline()

            print('<<<', r.decode(), end='')
            print('[*] Listening...')

            chunks_received = {}
            bytes_received = 0
            num_expected_chunks = None
            missing_chunks = set()
            while incoming_bytes == 0 or bytes_received < incoming_bytes:
                # timeouts after 5s (or configured timeout)
                if r := ser_ground.read_until(b'\r\n'):
                    matches = re.finditer(r'RX "(\w+?)"', r.decode())
                    chunk_bytes = bytes.fromhex(''.join([x.group(1) for x in matches]))

                    # parse start of transmission header, skipping invalid ones
                    if incoming_bytes == 0 and chunk_bytes:
                        preamble, incoming_bytes, width, height = struct.unpack('>4sIII', chunk_bytes[:PROTOCOL_HEADER_SIZE])

                        # invalid preamble
                        if preamble != b'LORA':
                            # if VERBOSE:
                            print('Received invalid preamble, dropping packet.')
                            incoming_bytes = 0
                            continue

                        # valid preamble, start receiving image
                        start_time = time.perf_counter_ns()
                        print(preamble.decode())
                        print(f'[*] Detected {width}x{height} image.')
                        print(f'[*] Receiving {incoming_bytes} bytes.')
                        chunk_bytes = chunk_bytes[PROTOCOL_HEADER_SIZE:]
                        num_expected_chunks = -(-incoming_bytes // CHUNK_SIZE)

                        # use higher timeout from now on, we will request retransmission
                        # if this timeout gets hit, we dont use this initially because it
                        # blocks keyboard interrupts for example.
                        ser_ground.timeout = RETRANSMISSION_TIMEOUT

                    if chunk_bytes:
                        seq_number, chunk_bytes = *struct.unpack('>H', chunk_bytes[:2]), chunk_bytes[2:]

                        # validate seq number using few heuristics
                        # 19535 is decimal for LO - can occur on overlap with new transmission
                        if seq_number == 19535 or seq_number < 0 or seq_number >= num_expected_chunks:
                            print('[!] Invalid sequence number received, dropping chunk.')
                            continue

                        if seq_number in missing_chunks:
                            print(f'[+] Received previously missing chunk {seq_number}!')
                            
                        # do not overwrite or double count
                        if seq_number not in chunks_received:
                            chunks_received[seq_number] = chunk_bytes
                            bytes_received += 2 + len(chunk_bytes)

                            if bytes_received % (incoming_bytes // 5) < max(incoming_bytes / 20, 200):
                                print(f'[*] Received {bytes_received} bytes')


                    if VERBOSE:
                        print(f"<<< {r}")
                
                # if we reach here it means we transmitter sent all and we have missing chunks AKA we
                # hit the RETRANSMISSION_TIMEOUT and should request missing chunks
                elif incoming_bytes:
                    missing_chunks = {seq for seq in range(num_expected_chunks) if seq not in chunks_received}
                    
                    print(f'[-] Timed out. Missing {len(missing_chunks)} chunk/s')

                    time.sleep(RX_SWITCH_DELAY)


                    if missing_chunks:
                        print(f'[*] Requesting retransmission of unreceived chunks: {missing_chunks}...')
                    else:
                        print('[+] Successfully recovered missing chunks. Sending confirmation...')

                    request_payload = b'MISS' + struct.pack('>H' + 'H' * len(missing_chunks), len(missing_chunks), *missing_chunks)  
                    print('[*] Request payload:', request_payload)

                    ser_ground.write(f'AT+TEST=TXLRPKT, "{request_payload.hex()}"\n'.encode())
                    # return AT TX confirmation
                    r = ser_ground.read_until(b"TX DONE\r\n").decode()

                    # return back to receiving
                    ser_ground.write(f'{AT_RXLRPKT}\n'.encode())

            # acknowledge successfully receiving all packets
            time.sleep(RX_SWITCH_DELAY)

            request_payload = b'MISS' + struct.pack('>H' + 'H' * len(missing_chunks), len(missing_chunks), *missing_chunks)  
            ser_ground.write(f'AT+TEST=TXLRPKT, "{request_payload.hex()}"\n'.encode())
            # return AT TX confirmation
            ser_ground.read_until(b"TX DONE\r\n").decode()
            print('[+] Confirmation sent')

            duration_ns = time.perf_counter_ns() - start_time
            duration_s = duration_ns / 10**9 

            # assemble buffer from received chunks
            buffer = b''.join(chunks_received.values())

            print(f'[*] Received {bytes_received} bytes over {len(chunks_received)} segments in {duration_s:.3f}s ({len(buffer)/duration_s:,.0f}) bytes/s')

            img_display = BytesIO(buffer)
            with open('bytes.bin', 'wb') as f:
                f.write(buffer)
                # load and view the image using pillow
                image = Image.open(img_display)
                image.show()

            print(f'[+] Saved {incoming_bytes} bytes to "bytes.bin"\n-----\n') 

    except FileNotFoundError as e:
        print(e)
        print(f"[-] Connection to {port} failed.")


# Drone serial wrapper
class Drone:
    def __init__(self, port=None, configure=False):
        self.port = port
        self.serial: Serial = None

        if self.connect():
            # print(f"[*] Clearing buffer: {self.serial.read_all()}")
            if configure:
                r = self.configure_tx()
                print(r)

    def configure_tx(self):
        output = ""
        drone_config = get_config_commands()
        for line in drone_config.split("\n"):
            self.serial.write(f'{line}\n'.encode())
            r = self.serial.readline().decode()
            if r:
                output += f'<<< {r}'

        return output

    def connect(self) -> bool:
        try:
            self.serial = Serial(
                port=self.port,
                baudrate=RF_CONFIG['baudrate'],
                bytesize=8,
                stopbits=1,
                parity="N",
                timeout=1,
            )

            return self.serial.is_open

        except FileNotFoundError:
            print(f"[-] Connection to {self.port} failed.")
            return False
        except Exception as e:
            print(f"[-] Connection to {self.port} failed: {e}")
            return False

    def send(self, data: bytes, recv=True) -> bytes:
        if not self.serial or not self.serial.is_open:
            print("[-] Send failed, Serial connection is not established.")

        self.serial.write(f'AT+TEST=TXLRPKT, "{data.hex()}"\n'.encode())

        # return AT confirmation, this may mess up things if you are not expecting send to recv on your behalf
        if recv:
            return self.serial.read_until(b"TX DONE\r\n").decode()

    def recv(self) -> bytes:
        r = self.serial.read_until(b'\r\n')

        matches = re.finditer(r'RX "(\w+?)"', r.decode())
        payload = bytes.fromhex(''.join([x.group(1) for x in matches]))

        return payload


class DroneGUI:
    def __init__(self, root, port, configure, auto):
        self.root = root
        self.root.title("STM32WLE5JC Drone")
        self.root.geometry("720x640")
        self.args_port = port
        self.configure = configure
        self.cancel = False

        self.drone = None

        self.create_layout()
        if auto:
            threading.Thread(target=self.connect_serial).start()

    def create_layout(self):
        self.controls_frame = tk.Frame(self.root, height=100)
        self.controls_frame.pack(fill="x", side="bottom")

        self.port_frame = tk.Frame(self.controls_frame)
        self.port_frame.pack(side="left", padx=10, pady=10)

        self.port_var = tk.StringVar(value=self.args_port)
        self.port_dropdown = tk.OptionMenu(self.port_frame, self.port_var, self.args_port)
        self.port_dropdown.pack(side="left")

        self.refresh_button = tk.Button(
            self.port_frame, text="↻", command=self.refresh_ports, width=2
        )
        self.refresh_ports()
        
        self.refresh_button.pack(side="left", padx=2)

        self.image_frame = tk.Frame(
            self.root, height=300, bg="lightgray", relief="ridge"
        )
        self.image_frame.pack(fill="both", expand=True)
        self.image_canvas = tk.Canvas(self.image_frame, bg="lightgray")
        self.image_canvas.pack(fill="both", expand=True)

        self.choose_button = tk.Button(
            self.controls_frame, text="Choose Image", command=self.choose_image
        )
        self.choose_button.pack(side="left", padx=10, pady=10)

        self.connect_button = tk.Button(
            self.controls_frame, text="Connect Serial", command=lambda: threading.Thread(target=self.connect_serial).start()
        )
        self.connect_button.pack(side="left", padx=10, pady=10)

        self.transmit_button = tk.Button(
            self.controls_frame,
            text="Transmit Image",
            state=tk.DISABLED,
            command=lambda: threading.Thread(target=self.transmit_image).start()
        )
        self.transmit_button.pack(side="left", padx=10, pady=10)

        self.cancel_button = tk.Button(
            self.controls_frame,
            text="Cancel Tranmission",
            state=tk.DISABLED,
            command=self.cancel_transmission,
        )
        self.cancel_button.pack(side="left", padx=10, pady=10)

        self.status_panel = tk.Frame(self.controls_frame)
        self.status_panel.pack(side="right", padx=5, pady=5)

        self.connection_panel = tk.Frame(self.status_panel)
        self.connection_panel.pack(side="bottom", padx=0, pady=0)

        self.connection_indicator = tk.Canvas(
            self.connection_panel,
            width=20,
            height=20,
            bg="#f0f0f0",
            highlightthickness=0,
        )
        self.connection_indicator.pack(side="left", anchor="w", padx=0)

        self.connection_indicator.create_oval(2, 2, 18, 18, fill="red", outline="")

        self.label_connected = tk.Label(
            self.connection_panel, text="Disconnected", anchor="w"
        )
        self.label_connected.pack(side="right", anchor="w")

        self.label_loaded = tk.Label(
            self.status_panel, text="Image: Not Loaded", anchor="w"
        )
        self.label_loaded.pack(side="right", anchor="w")

        self.text_frame = tk.Frame(self.root)
        self.text_frame.pack(fill="both", expand=True, padx=10, pady=10)

        self.scrollbar = tk.Scrollbar(self.text_frame)
        self.scrollbar.pack(side="right", fill="y")

        global status_text_box
        # global status_text_box, write to it using print
        status_text_box = tk.Text(
            self.text_frame,
            wrap="word",
            height=8,
            width=50,
            yscrollcommand=self.scrollbar.set,
        )
        status_text_box.pack(side="left", fill="both", expand=True)

        self.scrollbar.config(command=status_text_box.yview)

    def choose_image(self):
        self.file_path = filedialog.askopenfilename(
            title="Select an Image",
            filetypes=[("Image Files", "*.png;*.jpg;*.jpeg;*.bmp;*.gif")],
        )
        if self.file_path:
            self.display_image(self.file_path)

    def cancel_transmission(self):
        self.cancel = True

    def refresh_ports(self):
        ports = scan_com_ports()
        menu = self.port_dropdown["menu"]
        menu.delete(0, "end")

        for port, description in ports:
            menu.add_command(
                label=f"{port}: {description}",
                command=lambda p=port: self.port_var.set(p),
            )

        if ports:
            found_port = [p for p in ports if p[0] == self.args_port]

            if found_port:
                self.port_var.set(found_port[0][0])
            else:
                self.port_var.set(ports[0][0])

    def display_image(self, path):
        image = Image.open(path)

        canvas_width = self.image_canvas.winfo_width()
        canvas_height = self.image_canvas.winfo_height()

        if canvas_width == 1 and canvas_height == 1:
            self.root.update_idletasks()
            canvas_width = self.image_canvas.winfo_width()
            canvas_height = self.image_canvas.winfo_height()

        image_ratio = image.width / image.height
        canvas_ratio = canvas_width / canvas_height

        if image_ratio > canvas_ratio:
            new_width = canvas_width
            new_height = int(canvas_width / image_ratio)
        else:
            new_height = canvas_height
            new_width = int(canvas_height * image_ratio)

        resized_image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)

        self.image = image
        self.tk_image = ImageTk.PhotoImage(resized_image)
        self.label_loaded.config(text=os.path.basename(path))
        self.image_canvas.delete("all")
        self.image_canvas.create_image(
            canvas_width / 2, canvas_height / 2, image=self.tk_image, anchor="center"
        )

    def connect_serial(self):
        print(f"[*] Connecting to drone on {self.port_var.get()} serial port.")

        self.drone = Drone(port=self.port_var.get(), configure=self.configure)

        if self.drone.serial.is_open:
            self.transmit_button.config(state=tk.NORMAL)
            self.label_connected.config(text="Connected")
            self.connect_button.config(state=tk.DISABLED)
            self.connection_indicator.create_oval(
                2, 2, 18, 18, fill="green", outline=""
            )
            print("[*] Connected. Ready to transmit.")

    def transmit_image(self):
        self.cancel_button.config(state=tk.NORMAL)
        self.cancel = False

        img_bytes = BytesIO()
        # img_bytes = self.image.convert("RGB").tobytes()
        # using ByteIO to trick pillow into saving the image in memory
        with open(self.file_path, "rb") as img_file:
            # image bytes without sequence numbers = bytes_to_send - 2 * num_image_chunks
            # as seen later
            img_bytes = img_file.read()

        num_image_chunks = -(-len(img_bytes) // CHUNK_SIZE)
        # consider chunk headers (2 bytes for sequence number currently)
        bytes_to_send = len(img_bytes) + 2 * num_image_chunks # bytes

        transmit_header = struct.pack(
            '>4sIII',
            b'LORA',
            bytes_to_send,
            self.image.width,
            self.image.height,
        )

        # send in 200 byte chunks (max RF frame is 255)
        total_bytes = PROTOCOL_HEADER_SIZE + bytes_to_send

        print(f'[*] Transmitting {total_bytes} bytes')
        start_time = time.perf_counter_ns()

        # first chunk contains header for the entire transmission
        for i in range(0, len(img_bytes), CHUNK_SIZE):
            if self.cancel:
                print('[!] Transmission canceled')
                break

            chunk = b''
            # first chunk is special
            if i == 0:
                chunk += transmit_header

            # give each chunk a sequence number, sequence number is normalized
            # i.e. 0, 1, 2, ... N-1 instead of 0, 200, 400, (N-1) * chunk_size
            chunk += struct.pack('>H', int(i / CHUNK_SIZE)) + img_bytes[i : i + CHUNK_SIZE]

            # stochastically fail packets to simulate real life
            if i != 0 and random() < 0.3:
                continue

            # fire off
            r = self.drone.send(chunk)
            
            # provide extra redundancy to the preamble chunks
            if i == 0:
                r = self.drone.send(chunk)
                r = self.drone.send(chunk)

            if VERBOSE:
                print(f">>> {img_bytes[i : i + CHUNK_SIZE].hex()}")
                print(r)

        # primary transmission is over, ensure all chunks has been received
        duration_ns = time.perf_counter_ns() - start_time
        duration_s = duration_ns / 10**9 
        print(f'[*] Completed first transmission in {duration_s:.3f}s ({total_bytes/duration_s:,.0f} bytes/s). Waiting for ground MISS report')

        # increase timeout during retransmission phase
        self.drone.serial.timeout = RETRANSMISSION_TIMEOUT // 2

        num_missing = -1
        retries = MAX_RETRIES
        while num_missing and retries:
            r = b''
            # enable rx, must be done here because we transmit after
            self.drone.serial.write(f'{AT_RXLRPKT}\n'.encode())
            r += self.drone.serial.read_until(b'\r\n')
            r += self.drone.serial.read_until(b'RX ')
            r += self.drone.serial.readline()

            if VERBOSE:
                print('<<<', r.decode())

            # why cant we do this to drain stream and get RX payload either way
            # while not (matches := re.finditer(r'RX "(\w+?)"', self.drone.serial.readline().decode())):

            matches = re.finditer(r'RX "(\w+?)"', r.decode())
            data = bytes.fromhex(''.join([x.group(1) for x in matches]))

            if not data:
                print('.', end='', flush=True)
                continue
            
            print()

            if not data.startswith(b'MISS'):
                print(r)
                continue

            header_MISS, header_COUNT, header_SEQS = data[:4], data[4:6], data[6:]

            num_missing, = struct.unpack('>H', header_COUNT)
            print(f'[*] Ground reported missing {num_missing} chunk/s')

            if num_missing == 0:
                break

            missing_chunk_seqs = struct.unpack('>' + 'H' * num_missing, header_SEQS)

            # wait before resending
            time.sleep(RX_SWITCH_DELAY)

            print(f'[*] Resending (retry: {MAX_RETRIES-retries+1}): {missing_chunk_seqs}')

            for seq in missing_chunk_seqs:
                print(f'[*] Sending {seq}')
                chunk_index = seq * CHUNK_SIZE
                r = self.drone.send(struct.pack('>H', seq) + img_bytes[chunk_index:chunk_index+CHUNK_SIZE])
            retries -= 1

        # reset timeout
        self.drone.serial.timeout = 1

        # report stats and reset GUI state
        total_duration_ns = time.perf_counter_ns() - duration_ns
        total_duration_s = duration_ns / 10**9 
        '[+] Retransmission successful'

        if self.cancel:
            print('[!] Canceled at {i:,} bytes after {total_duration_s:.3f}')
        else:
            print(
                    f"[+] Sent {total_bytes} bytes over {num_image_chunks} packets in {total_duration_s:.3f}s ({total_bytes/duration_s:,.0f} bytes/s)"
            )
        self.cancel_button.config(state=tk.DISABLED)

def launch_client(port, configure, auto):
    root = tk.Tk()
    DroneGUI(root, port, configure, auto)

    root.mainloop()

if __name__ == '__main__':
    args = get_args()
    VERBOSE = args.verbose
    if VERBOSE:
        print('! Increased verbosity !')
        print('Running with args:', args)

    # shared config & args
    RF_CONFIG['spreading_factor'] = args.sf
    RF_CONFIG['power_dbm'] = args.dbm
    RF_CONFIG['bandwidth'] = args.bandwidth
    port = args.port
    configure = args.configure

    # mode-specific config
    if args.mode == 'client':
        print('Running in client mode')

        auto = args.auto

        launch_client(port, configure, auto)

    elif args.mode == 'server':
        print('Running in server mode')
        
        while True:
            launch_server(port, configure)

