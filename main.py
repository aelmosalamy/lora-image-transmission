import os
import time
import struct
import tkinter as tk
from serial import Serial
from io import BytesIO
from datetime import datetime
from threading import Thread
from tkinter import filedialog
from PIL import Image, ImageTk

ENABLE_LOG = False

# AT+TEST=RFCFG,868,SF6,250,12,15,14,ON,OFF,OFF
# Available baud rate are 9600 14400 19200 38400 57600 76800 115200 and 230400

drone_config = f'''\
AT+LOG={'DEBUG' if ENABLE_LOG else 'QUIET'}
AT+UART=BR, 230400
AT+MODE=TEST
AT+TEST=RFCFG,868,SF6,500,12,15,14,ON,OFF,OFF
'''.encode()
# AT+TEST=TXLRPKT, "00 AA 11 BB 22 CC"
# AT+TEST=TXLRSTR, "hello"

status_text_box: tk.Text = None

# utilities
def timestamp() -> str:
    return datetime.now().strftime("%H:%M:%S")

def print(*args, **kwargs):
    if status_text_box:
        status_text_box.insert(tk.END, f'{timestamp()}: {' '.join(str(_) for _ in args)} \n')

    __builtins__.print(*args, **kwargs)


# Drone serial wrapper
class Drone:
    def __init__(self, auto_connect=True):
        self.port = 'COM3'
        self.serial: Serial = None

        if auto_connect:
            self.connect()
            print(f'[*] Clearing buffer: {self.serial.read_all()}')
            r = self.configure_tx()
            print(r)

    def configure_tx(self):
        output = ''
        for line in drone_config.split(b'\n'):
            self.serial.write(line + b'\n')
            time.sleep(0.2)
            output += self.serial.read_until('\n').decode()

        return output

    def connect(self) -> bool:
        try:
            self.serial = Serial(port=self.port, baudrate=230400, bytesize=8, stopbits=1, parity='N', timeout=1)
        
            return self.serial.is_open

        except FileNotFoundError:
            print(f"[-] Connection to {self.port} failed.")
        except Exception as e:
            print(f'[-] Connection to {self.port} failed: {e}')

    def send(self, data: bytes) -> bytes:
        if not self.serial or not self.serial.is_open:
            print(f"[-] Send failed, Serial connection is not established.")

        self.serial.write(f'AT+TEST=TXLRPKT, "{data.hex()}"\n'.encode())
        return self.serial.read_until(b'TX DONE\r\n').decode()

class App_TX:
    def __init__(self, root):
        self.root = root
        self.root.title("STM32WLE5JC Drone")
        self.root.geometry("720x640")

        self.drone = None

        self.create_layout()

    def create_layout(self):
        self.image_frame = tk.Frame(self.root, height=300, bg="lightgray", relief="ridge")
        self.image_frame.pack(fill="both", expand=True)
        self.image_canvas = tk.Canvas(self.image_frame, bg="lightgray")
        self.image_canvas.pack(fill="both", expand=True)

        self.controls_frame = tk.Frame(self.root, height=100)
        self.controls_frame.pack(fill="x", side="bottom")

        self.choose_button = tk.Button(self.controls_frame, text="Choose Image", command=self.choose_image)
        self.choose_button.pack(side="left", padx=10, pady=10)

        self.connect_button = tk.Button(self.controls_frame, text="Connect Serial", command=self.connect_serial)
        self.connect_button.pack(side="left", padx=10, pady=10)

        self.transmit_button = tk.Button(self.controls_frame, text="Transmit Image", state=tk.DISABLED, command=self.transmit_image)
        self.transmit_button.pack(side="left", padx=10, pady=10)

        self.status_panel = tk.Frame(self.controls_frame)
        self.status_panel.pack(side="right", padx=5, pady=5)

        self.connection_panel = tk.Frame(self.status_panel)
        self.connection_panel.pack(side="bottom", padx=0, pady=0)

        self.connection_indicator = tk.Canvas(self.connection_panel, width=20, height=20, bg="#f0f0f0", highlightthickness=0)
        self.connection_indicator.pack(side="left", anchor="w", padx=0)

        self.connection_indicator.create_oval(2, 2, 18, 18, fill="red", outline="")
        
        self.label_connected = tk.Label(self.connection_panel, text="Disconnected", anchor="w")
        self.label_connected.pack(side="right", anchor="w")

        self.label_loaded = tk.Label(self.status_panel, text="Image: Not Loaded", anchor="w")
        self.label_loaded.pack(side="right", anchor="w")

        self.text_frame = tk.Frame(self.root)
        self.text_frame.pack(fill="both", expand=True, padx=10, pady=10)

        self.scrollbar = tk.Scrollbar(self.text_frame)
        self.scrollbar.pack(side="right", fill="y")

        global status_text_box
        # global status_text_box, write to it using print
        status_text_box = tk.Text(self.text_frame, wrap="word", height=8, width=50, yscrollcommand=self.scrollbar.set)
        status_text_box.pack(side="left", fill="both", expand=True)

        self.scrollbar.config(command=status_text_box.yview)

    def choose_image(self):
        file_path = filedialog.askopenfilename(
            title="Select an Image",
            filetypes=[("Image Files", "*.png;*.jpg;*.jpeg;*.bmp;*.gif")]
        )
        if file_path:
            self.display_image(file_path)

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
        self.image_canvas.delete("all")
        self.image_canvas.create_image(canvas_width / 2, canvas_height / 2, image=self.tk_image, anchor="center")

    def connect_serial(self):
        self.drone = Drone()

        print('[*] Connecting to drone on COM3 serial port.')

        if c := self.drone.serial.is_open:
            print('[*] Connected. Ready to transmit.')

            self.transmit_button.config(state=tk.NORMAL)
            self.label_connected.config(text="Connected")
            self.connection_indicator.create_oval(2, 2, 18, 18, fill="green", outline="")

    def transmit_image(self):
        # img_bytes = BytesIO()
        img_bytes = self.image.convert('RGB').tobytes()
        # using ByteIO to trick pillow into saving the image in memory
        # self.image.save(img_bytes, format='PNG')

        # img_bytes = img_bytes.getvalue()
        img_size = 100 and len(img_bytes)

        transmit_buffer = struct.pack('>II', self.image.width, self.image.height) + img_bytes 

        print(f'[*] Transmitting {len(transmit_buffer) / 1024:.1f}KB')
        
        # send in 200 byte chunks (max RF frame is 255)
        chunk_size = 200
        for i in range(0, img_size + 8, chunk_size):
            r = self.drone.send(transmit_buffer[i:i+chunk_size])
            if ENABLE_LOG:
                print(f'>>> {transmit_buffer[i:i+chunk_size].hex()}')
                print(r)
        print(f'[+] Sent {(img_size+8) / chunk_size:.1f} packets')


root = tk.Tk()
app = App_TX(root)
root.mainloop()