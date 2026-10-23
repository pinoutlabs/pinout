"""Raspberry Pi Pico (RP2040) deployment defaults for the MicroPython bridge.

Copy this file to the board filesystem as `config.py` alongside `main.py`:

  mpremote cp main.py :
  mpremote cp boards/raspberry-pi-pico/config.py :config.py

Transport is USB CDC (sys.stdin/stdout) so a desk/school Pico needs only the
onboard USB cable — no external UART adapter. Status: SIMULATED on host;
not HARDWARE_VERIFIED.
"""

BOARD_ID = "raspberry-pi-pico"

# USB CDC over the Pico's native USB serial. Use "uart" only when wiring a
# separate USB-UART adapter to UART_TX_PIN / UART_RX_PIN.
TRANSPORT = "usb"

UART_ID = 0
UART_BAUD = 115200
UART_TX_PIN = 0
UART_RX_PIN = 1

# Onboard LED on the non-W Pico (GPIO 25). Pico W uses a different LED path.
LED_PIN = 25

# Default I2C (matches firmware/boards/raspberry-pi-pico.json).
I2C_SCL_PIN = 5
I2C_SDA_PIN = 4
I2C_FREQUENCY = 100000

# Default SPI (matches firmware/boards/raspberry-pi-pico.json).
SPI_SCK_PIN = 18
SPI_MOSI_PIN = 19
SPI_MISO_PIN = 16
SPI_CS_PIN = 17
SPI_FREQUENCY = 1000000

# SMPS power-save, VBUS sense, ADC VREF / VSYS sense — never drive these.
RESERVED_PINS = frozenset({23, 24, 29})

# Usable GPIOs from the board descriptor (includes onboard LED on 25).
ALLOWED_PINS = frozenset(
    [
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        11,
        12,
        13,
        14,
        15,
        16,
        17,
        18,
        19,
        20,
        21,
        22,
        25,
        26,
        27,
        28,
    ]
)

ADC_PINS = frozenset({26, 27, 28})

MAX_WATCHES = 8
