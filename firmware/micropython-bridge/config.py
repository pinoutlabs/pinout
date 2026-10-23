"""Deployment-configurable pin and bus defaults.

Edit this file per-board before installing the bridge, or replace it with a
board profile from `boards/<board-id>/config.py` (recommended for Pico:

  mpremote cp boards/raspberry-pi-pico/config.py :config.py

The bridge performs runtime capability detection and stays conservative: when
a peripheral is unavailable it reports a protocol error instead of guessing.
"""

# Optional board identity advertised in sys.hello / ready (e.g. raspberry-pi-pico).
BOARD_ID = None

# "usb" = NDJSON over USB CDC (sys.stdin/stdout) — preferred for Pico desk use.
# "uart" = NDJSON over machine.UART (needs a USB-UART adapter on UART_* pins).
# Host validation without `machine` always uses stdin/stdout regardless.
TRANSPORT = "usb"

# UART used when TRANSPORT == "uart".
UART_ID = 0
UART_BAUD = 115200
UART_TX_PIN = 0
UART_RX_PIN = 1

# Optional onboard LED pin (Pico non-W: 25). None when unknown.
LED_PIN = None

# Default I2C bus pins (board-specific — check your pinout diagram).
I2C_SCL_PIN = 9
I2C_SDA_PIN = 8
I2C_FREQUENCY = 100000

# Default SPI bus pins.
SPI_SCK_PIN = 6
SPI_MOSI_PIN = 7
SPI_MISO_PIN = 4
SPI_FREQUENCY = 1000000

# Pins the bridge must never drive (flash, strap, power).
RESERVED_PINS = frozenset()

# When non-empty, only these pins may be used for GPIO/ADC/PWM. Empty = any
# non-negative integer except RESERVED_PINS (board-agnostic software mode).
ALLOWED_PINS = frozenset()

# Optional ADC-capable pin set for clearer INVALID_PIN messages.
ADC_PINS = frozenset()

# Maximum software-tracked watch points.
MAX_WATCHES = 8
