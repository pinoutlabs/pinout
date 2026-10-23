"""Host-side stub of MicroPython's `machine` module for CI / simulation.

Import this by putting `firmware/micropython-bridge/sim` on PYTHONPATH ahead of
the real stdlib. It is not MicroPython firmware and must never be copied to a
board. All pin/ADC/PWM/I2C/SPI state lives in process memory so protocol tests
can exercise the HARDWARE=True code paths without a Pico attached.

Evidence level: SIMULATED only.
"""

from __future__ import annotations


class Pin:
    IN = 0
    OUT = 1
    PULL_UP = 1
    PULL_DOWN = 2

    _values = {}  # type: dict[int, int]

    def __init__(self, pinId, mode=OUT, pull=None):
        self.id = int(pinId)
        self.mode = mode
        self.pull = pull
        if self.id not in Pin._values:
            Pin._values[self.id] = 0

    def value(self, level=None):
        if level is None:
            return Pin._values.get(self.id, 0)
        Pin._values[self.id] = 1 if level else 0
        return None

    def on(self):
        self.value(1)

    def off(self):
        self.value(0)


class ADC:
    def __init__(self, pin):
        self.pin = pin.id if hasattr(pin, "id") else int(pin)

    def read_u16(self):
        # Deterministic soft level: mid-scale so host tests can assert shape.
        return 32768


class PWM:
    def __init__(self, pin):
        self.pin = pin
        self._freq = 1000
        self._duty = 0

    def freq(self, value=None):
        if value is None:
            return self._freq
        self._freq = int(value)
        return None

    def duty_u16(self, value=None):
        if value is None:
            return self._duty
        self._duty = int(value)
        return None

    def duty(self, value=None):
        if value is None:
            return int(self._duty * 1023 / 65535)
        self._duty = int(value * 65535 / 1023)
        return None

    def deinit(self):
        return None


class SoftI2C:
    def __init__(self, scl=None, sda=None, freq=100000):
        self.scl = scl
        self.sda = sda
        self.freq = freq
        self._devices = {}  # type: dict[int, bytearray]

    def scan(self):
        return sorted(self._devices.keys())

    def writeto(self, address, data):
        self._devices[address] = bytearray(data)
        return len(data)

    def readfrom(self, address, length):
        stored = self._devices.get(address, bytearray())
        if len(stored) < length:
            stored = stored + bytearray(length - len(stored))
        return bytes(stored[:length])


class SoftSPI:
    def __init__(self, baudrate=1000000, polarity=0, phase=0, sck=None, mosi=None, miso=None):
        self.baudrate = baudrate
        self.polarity = polarity
        self.phase = phase
        self.sck = sck
        self.mosi = mosi
        self.miso = miso

    def write_readinto(self, outgoing, incoming):
        # Loopback: host tests assert transfer shape, not bus physics.
        for index in range(len(outgoing)):
            incoming[index] = outgoing[index]


class UART:
    def __init__(self, uartId, baudrate=115200):
        self.id = uartId
        self.baudrate = baudrate
        self._buffer = b""

    def write(self, data):
        return len(data)

    def read(self):
        if not self._buffer:
            return None
        data = self._buffer
        self._buffer = b""
        return data


class I2C(SoftI2C):
    pass


class SPI(SoftSPI):
    def __init__(self, spiId, **kwargs):
        super().__init__(**kwargs)
        self.id = spiId


def reset():
    """Clear simulated pin state between test runs."""
    Pin._values.clear()
