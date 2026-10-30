"""Pinout bridge for MicroPython boards.

Speaks the Pinout NDJSON wire protocol (v1) over a UART (on hardware) or
stdin/stdout (for host-side validation and simulation). One JSON object per
line:

  request  {"v":1,"id":"1","action":"gpio.write","payload":{"pin":2,"value":1}}
  response {"v":1,"id":"1","ok":true,"result":{...}}
           {"v":1,"id":"1","ok":false,"error":{"code":"...","message":"..."}}

Capability advertisement is runtime and conservative: sys.hello/sys.info list
only what this runtime can actually execute, and unsupported requests fail
with structured error codes instead of fabricated values:

  INVALID_PIN            pin malformed, reserved, unsupported or not configured
  INVALID_PAYLOAD        missing or out-of-range request fields
  UNSUPPORTED_CAPABILITY runtime lacks the requested peripheral
  BUS_ERROR              peripheral I/O failed (e.g. an I2C NACK)
  WATCH_TABLE_FULL       too many gpio.watch points
  UNSUPPORTED_ACTION     unknown action
  ACTION_FAILED          anything else

Pin state is always tracked in software so gpio.read/toggle work everywhere;
on hardware the physical pin is driven as well.

Support status: EXPERIMENTAL — not hardware-verified. CircuitPython is not
supported: this bridge requires the MicroPython `machine` module.
"""

import json
import sys
import time

try:
    import config as cfg
except ImportError:  # pragma: no cover - config always ships with the bridge
    cfg = None

PROTOCOL_VERSION = 1
FIRMWARE_NAME = "micropython-bridge"
FIRMWARE_VERSION = "0.2.0"
# Maximum protocol frame size in bytes (1024) matching host and ESP32 bridge.
LINE_MAX = 1024

# 50 Hz hobby-servo timing (same pulse window as the ESP32 bridge).
SERVO_FREQUENCY = 50
SERVO_MIN_US = 1000
SERVO_MAX_US = 2000
SERVO_PERIOD_US = 20000

# ---------------------------------------------------------------------------
# Hardware detection: `machine` exists on MicroPython boards. On a laptop the
# bridge runs in software-only mode (used by validate.js).
# ---------------------------------------------------------------------------

try:
    import machine  # type: ignore

    HARDWARE = True
except ImportError:
    machine = None
    HARDWARE = False


def _config(name, fallback):
    """Read a config.py setting with a conservative fallback."""
    return getattr(cfg, name, fallback) if cfg is not None else fallback


BOARD_ID = _config("BOARD_ID", None)
TRANSPORT = _config("TRANSPORT", "usb")
ALLOWED_PINS = frozenset(_config("ALLOWED_PINS", frozenset()))
ADC_PINS = frozenset(_config("ADC_PINS", frozenset()))
LED_PIN = _config("LED_PIN", None)
RESERVED_PINS = frozenset(_config("RESERVED_PINS", frozenset()))
MAX_WATCHES = _config("MAX_WATCHES", 8)
UART_ID = _config("UART_ID", 0)
UART_BAUD = _config("UART_BAUD", 115200)
UART_TX_PIN = _config("UART_TX_PIN", 0)
UART_RX_PIN = _config("UART_RX_PIN", 1)
I2C_SCL_PIN = _config("I2C_SCL_PIN", 9)
I2C_SDA_PIN = _config("I2C_SDA_PIN", 8)
I2C_FREQUENCY = _config("I2C_FREQUENCY", 100000)
SPI_SCK_PIN = _config("SPI_SCK_PIN", 6)
SPI_MOSI_PIN = _config("SPI_MOSI_PIN", 7)
SPI_MISO_PIN = _config("SPI_MISO_PIN", 4)
SPI_FREQUENCY = _config("SPI_FREQUENCY", 1000000)


def detect_capabilities():
    """Advertise only the actions this runtime can execute.

    Software mode keeps a GPIO/PWM/servo shadow, so those stay advertised.
    ADC and the buses are hardware-only: they are never advertised without a
    `machine` module, and hardware needs the concrete peripheral class.
    """
    capabilities = [
        "sys.hello",
        "sys.ping",
        "sys.info",
        "gpio.mode",
        "gpio.read",
        "gpio.write",
        "gpio.toggle",
        "gpio.watch",
    ]
    if not HARDWARE or hasattr(machine, "PWM"):
        capabilities += ["pwm.configure", "pwm.write", "gpio.servo"]
    if HARDWARE:
        if hasattr(machine, "ADC"):
            capabilities.append("adc.read")
        if hasattr(machine, "SoftI2C") or hasattr(machine, "I2C"):
            capabilities += ["i2c.scan", "i2c.read", "i2c.write"]
        if hasattr(machine, "SoftSPI") or hasattr(machine, "SPI"):
            capabilities.append("spi.transfer")
    return capabilities


CAPABILITIES = detect_capabilities()


class ProtocolError(Exception):
    """Bridge failure that maps to a stable protocol error code."""

    code = "ACTION_FAILED"


class InvalidPin(ProtocolError):
    code = "INVALID_PIN"


class InvalidPayload(ProtocolError):
    code = "INVALID_PAYLOAD"


class UnsupportedCapability(ProtocolError):
    code = "UNSUPPORTED_CAPABILITY"


class WatchTableFull(ProtocolError):
    code = "WATCH_TABLE_FULL"


def _byte_values(values, field):
    """Validate a JSON byte array (1..32 bytes) and return a bytearray."""
    if not isinstance(values, list) or not 1 <= len(values) <= 32:
        raise InvalidPayload("%s must be a list of 1..32 bytes" % field)
    out = bytearray()
    for value in values:
        if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 255:
            raise InvalidPayload("%s must contain integers in [0, 255]" % field)
        out.append(value)
    return out


class Bridge:
    def __init__(self):
        self.pin_modes = {}      # pin -> "input" | "input-pullup" | ... | "output"
        self.pin_values = {}     # pin -> 0 | 1 (software shadow of every pin)
        self.hardware_pins = {}  # (pin, mode) -> machine.Pin when hardware-backed
        self.watches = {}        # pin -> last observed value
        self.adc_channels = {}   # pin -> machine.ADC
        self.pwm = {}            # pin -> {"pwm": machine.PWM|None, "frequency", "duty"}
        self.i2c = None
        self.spi = None

    # -- helpers -------------------------------------------------------------

    def _check_pin(self, pin, for_adc=False):
        if not isinstance(pin, int) or isinstance(pin, bool) or pin < 0:
            raise InvalidPin("pin must be a non-negative integer")
        if pin in RESERVED_PINS:
            raise InvalidPin("pin %d is reserved" % pin)
        if ALLOWED_PINS and pin not in ALLOWED_PINS:
            raise InvalidPin("pin %d is not a usable GPIO on this board" % pin)
        if for_adc and ADC_PINS and pin not in ADC_PINS:
            raise InvalidPin("pin %d does not support ADC on this board" % pin)

    def _hardware_pin(self, pin, mode):
        """Return a machine.Pin for `pin` or None in software-only mode."""
        if not HARDWARE:
            return None
        key = (pin, mode)
        cached = self.hardware_pins.get(key)
        if cached is not None:
            return cached
        pin_mode = machine.Pin.OUT if mode == "output" else machine.Pin.IN
        hw = machine.Pin(pin, pin_mode)
        self.hardware_pins[key] = hw
        return hw

    def _release_pwm(self, pin):
        """Stop and forget a PWM/servo voice on `pin`, if any."""
        entry = self.pwm.pop(pin, None)
        if entry is None:
            return
        hw_pwm = entry.get("pwm")
        if hw_pwm is not None and hasattr(hw_pwm, "deinit"):
            try:
                hw_pwm.deinit()
            except Exception:
                pass

    def _ensure_pwm(self, pin, frequency):
        """Create or retune the PWM voice for `pin` at `frequency`."""
        entry = self.pwm.get(pin)
        if entry is not None:
            entry["frequency"] = frequency
            hw_pwm = entry.get("pwm")
            if hw_pwm is not None:
                hw_pwm.freq(frequency)
            return entry
        hw_pwm = None
        if HARDWARE:
            if not hasattr(machine, "PWM"):
                raise UnsupportedCapability("pwm requires machine.PWM (none on this runtime)")
            hw_pwm = machine.PWM(self._hardware_pin(pin, "output"))
        entry = {"pwm": hw_pwm, "frequency": frequency, "duty": 0}
        self.pwm[pin] = entry
        if hw_pwm is not None:
            hw_pwm.freq(frequency)
        self.pin_modes[pin] = "output"
        self.pin_values.pop(pin, None)
        return entry

    def _write_pwm_duty(self, entry, duty):
        """Store `duty` (0..65535) and drive the hardware PWM when present."""
        entry["duty"] = duty
        hw_pwm = entry.get("pwm")
        if hw_pwm is None:
            return
        if hasattr(hw_pwm, "duty_u16"):
            hw_pwm.duty_u16(duty)
        else:
            hw_pwm.duty(int(duty * 1023 / 65535))

    # -- sys actions ----------------------------------------------------------

    def sys_hello(self, payload):
        info = self.sys_info(payload)
        return {
            "firmware": info["firmware"],
            "version": info["version"],
            "protocol": info["protocol"],
            "hardware": info["hardware"],
            "board": info["board"],
            "boardId": BOARD_ID or info["board"],
            "ledPin": LED_PIN,
            "machine": info["machine"],
            "capabilities": info["capabilities"],
        }

    def sys_ping(self, payload):
        return {"pong": True}

    def sys_info(self, payload):
        """Deterministic identity payload (same input -> same output)."""
        board = "host"
        machine_name = "simulator"
        if HARDWARE:
            board = "micropython"
            machine_name = "unknown"
            try:
                import os

                uname = os.uname()
                board = getattr(uname, "sysname", None) or board
                machine_name = getattr(uname, "machine", None) or machine_name
            except Exception:
                pass
        return {
            "firmware": FIRMWARE_NAME,
            "version": FIRMWARE_VERSION,
            "protocol": PROTOCOL_VERSION,
            "hardware": HARDWARE,
            "board": board,
            "boardId": BOARD_ID or board,
            "ledPin": LED_PIN,
            "machine": machine_name,
            "capabilities": list(CAPABILITIES),
        }

    # -- gpio actions ----------------------------------------------------------

    def gpio_mode(self, payload):
        pin = payload.get("pin")
        mode = payload.get("mode")
        self._check_pin(pin)
        if mode not in ("input", "input-pullup", "input-pulldown", "output"):
            raise InvalidPayload("mode must be input, input-pullup, input-pulldown or output")
        self._release_pwm(pin)
        self.pin_modes[pin] = mode
        if mode == "output":
            return {"pin": pin, "mode": mode}
        if HARDWARE:
            if mode == "input-pullup":
                pull = getattr(machine.Pin, "PULL_UP", None)
            elif mode == "input-pulldown":
                pull = getattr(machine.Pin, "PULL_DOWN", None)
            else:
                pull = None
            try:
                if pull is None:
                    hw = machine.Pin(pin, machine.Pin.IN)
                else:
                    hw = machine.Pin(pin, machine.Pin.IN, pull)
            except (TypeError, ValueError):
                hw = machine.Pin(pin, machine.Pin.IN)
            self.hardware_pins[(pin, "input")] = hw
        return {"pin": pin, "mode": mode}

    def gpio_read(self, payload):
        pin = payload.get("pin")
        self._check_pin(pin)
        mode = self.pin_modes.get(pin, "")
        if HARDWARE and mode.startswith("input"):
            hw = self._hardware_pin(pin, "input")
            if hw is not None:
                value = 1 if hw.value() else 0
                self.pin_values[pin] = value
                return {"pin": pin, "value": value}
        if pin not in self.pin_values:
            raise InvalidPin("pin %d has no known value; call gpio.mode or gpio.write first" % pin)
        return {"pin": pin, "value": self.pin_values[pin]}

    def gpio_write(self, payload):
        pin = payload.get("pin")
        value = payload.get("value")
        self._check_pin(pin)
        if isinstance(value, bool):
            value = int(value)
        if not isinstance(value, int) or value not in (0, 1):
            raise InvalidPayload("value must be 0 or 1")
        mode = self.pin_modes.get(pin)
        if mode is not None and mode != "output":
            raise InvalidPin("pin %d is configured as %s; call gpio.mode first" % (pin, mode))
        self._release_pwm(pin)
        self.pin_modes[pin] = "output"
        self.pin_values[pin] = value
        hw = self._hardware_pin(pin, "output")
        if hw is not None:
            hw.value(value)
        return {"pin": pin, "value": value}

    def gpio_toggle(self, payload):
        pin = payload.get("pin")
        self._check_pin(pin)
        if pin not in self.pin_values:
            raise InvalidPin("pin %d has no known value; call gpio.write first" % pin)
        return self.gpio_write({"pin": pin, "value": 0 if self.pin_values[pin] else 1})

    def gpio_watch(self, payload):
        pin = payload.get("pin")
        self._check_pin(pin)
        enable = payload.get("enable", True)
        if not isinstance(enable, bool):
            raise InvalidPayload("enable must be a boolean")
        if enable:
            if pin not in self.watches and len(self.watches) >= MAX_WATCHES:
                raise WatchTableFull("watch table full (max %d)" % MAX_WATCHES)
            self.watches[pin] = self.pin_values.get(pin, 0)
            return {"pin": pin, "watching": True}
        self.watches.pop(pin, None)
        return {"pin": pin, "watching": False}

    # -- adc / pwm / servo ------------------------------------------------------

    def adc_read(self, payload):
        pin = payload.get("pin")
        self._check_pin(pin, for_adc=True)
        if not HARDWARE or not hasattr(machine, "ADC"):
            raise UnsupportedCapability("adc.read requires machine.ADC (none on this runtime)")
        adc = self.adc_channels.get(pin)
        if adc is None:
            try:
                adc = machine.ADC(machine.Pin(pin))
            except (TypeError, ValueError):
                raise InvalidPin("pin %d does not support adc.read" % pin)
            self.adc_channels[pin] = adc
        if hasattr(adc, "read_u16"):
            return {"pin": pin, "raw": adc.read_u16(), "scale": 65535}
        return {"pin": pin, "raw": adc.read(), "scale": 4095}

    def pwm_configure(self, payload):
        pin = payload.get("pin")
        frequency = payload.get("frequency", 1000)
        self._check_pin(pin)
        if not isinstance(frequency, int) or isinstance(frequency, bool):
            raise InvalidPayload("frequency must be an integer in [1, 100000]")
        if not 1 <= frequency <= 100000:
            raise InvalidPayload("frequency must be an integer in [1, 100000]")
        self._ensure_pwm(pin, frequency)
        return {"pin": pin, "frequency": frequency}

    def pwm_write(self, payload):
        pin = payload.get("pin")
        duty = payload.get("duty")
        self._check_pin(pin)
        entry = self.pwm.get(pin)
        if entry is None:
            raise InvalidPin("pin %d has no PWM configuration; call pwm.configure first" % pin)
        if not isinstance(duty, int) or isinstance(duty, bool) or not 0 <= duty <= 65535:
            raise InvalidPayload("duty must be an integer in [0, 65535]")
        self._write_pwm_duty(entry, duty)
        return {"pin": pin, "duty": duty}

    def gpio_servo(self, payload):
        pin = payload.get("pin")
        angle = payload.get("angle")
        self._check_pin(pin)
        if isinstance(angle, bool) or not isinstance(angle, (int, float)):
            raise InvalidPayload("angle must be a number in [0, 180]")
        if not 0 <= angle <= 180:
            raise InvalidPayload("angle must be a number in [0, 180]")
        entry = self._ensure_pwm(pin, SERVO_FREQUENCY)
        pulse_us = SERVO_MIN_US + (float(angle) / 180.0) * (SERVO_MAX_US - SERVO_MIN_US)
        self._write_pwm_duty(entry, int(pulse_us * 65535 / SERVO_PERIOD_US))
        entry["servoAngle"] = angle
        return {"pin": pin, "angle": angle}

    # -- i2c / spi -----------------------------------------------------------

    def _ensure_i2c(self):
        if self.i2c is not None:
            return self.i2c
        if not HARDWARE or not (hasattr(machine, "SoftI2C") or hasattr(machine, "I2C")):
            raise UnsupportedCapability(
                "i2c requires machine.I2C or machine.SoftI2C (none on this runtime)"
            )
        if hasattr(machine, "SoftI2C"):
            self.i2c = machine.SoftI2C(
                scl=machine.Pin(I2C_SCL_PIN), sda=machine.Pin(I2C_SDA_PIN), freq=I2C_FREQUENCY
            )
        else:
            self.i2c = machine.I2C(I2C_SCL_PIN, I2C_SDA_PIN, freq=I2C_FREQUENCY)
        return self.i2c

    def i2c_scan(self, payload):
        bus = self._ensure_i2c()
        return {"addresses": [hex(address) for address in bus.scan()]}

    def i2c_write(self, payload):
        address = payload.get("address")
        data = payload.get("data")
        if not isinstance(address, int) or isinstance(address, bool) or not 0 <= address <= 127:
            raise InvalidPayload("address must be an integer in [0, 127]")
        out = _byte_values(data, "data")
        bus = self._ensure_i2c()
        bus.writeto(address, bytes(out))
        return {"address": address, "written": len(out)}

    def i2c_read(self, payload):
        address = payload.get("address")
        length = payload.get("length")
        if not isinstance(address, int) or isinstance(address, bool) or not 0 <= address <= 127:
            raise InvalidPayload("address must be an integer in [0, 127]")
        if not isinstance(length, int) or isinstance(length, bool) or not 1 <= length <= 32:
            raise InvalidPayload("length must be an integer in [1, 32]")
        bus = self._ensure_i2c()
        data = bus.readfrom(address, length)
        return {"address": address, "data": list(data)}

    def _ensure_spi(self):
        if self.spi is not None:
            return self.spi
        if not HARDWARE or not (hasattr(machine, "SoftSPI") or hasattr(machine, "SPI")):
            raise UnsupportedCapability(
                "spi requires machine.SPI or machine.SoftSPI (none on this runtime)"
            )
        if hasattr(machine, "SoftSPI"):
            self.spi = machine.SoftSPI(
                baudrate=SPI_FREQUENCY,
                polarity=0,
                phase=0,
                sck=machine.Pin(SPI_SCK_PIN),
                mosi=machine.Pin(SPI_MOSI_PIN),
                miso=machine.Pin(SPI_MISO_PIN),
            )
        else:
            self.spi = machine.SPI(0)
        return self.spi

    def spi_transfer(self, payload):
        data = _byte_values(payload.get("data"), "data")
        bus = self._ensure_spi()
        received = bytearray(len(data))
        bus.write_readinto(bytes(data), received)
        return {"data": list(received)}


# ---------------------------------------------------------------------------
# Protocol plumbing
# ---------------------------------------------------------------------------

def handle_request(bridge, request):
    """Dispatch one parsed request object; returns a response object."""
    action = request["action"]
    payload = request.get("payload", {})
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        return _failure(request["id"], "INVALID_PAYLOAD", "payload must be an object.")
    handler = HANDLERS.get(action)
    if handler is None:
        return _failure(request["id"], "UNSUPPORTED_ACTION", "Unknown action '%s'." % action)
    try:
        result = handler(bridge, payload)
        return {"v": PROTOCOL_VERSION, "id": request["id"], "ok": True, "result": result}
    except ProtocolError as error:
        return _failure(request["id"], error.code, str(error))
    except OSError as error:
        return _failure(request["id"], "BUS_ERROR", str(error) or "hardware bus error")
    except Exception as error:
        return _failure(request["id"], "ACTION_FAILED", str(error))


def _failure(request_id, code, message):
    return {
        "v": PROTOCOL_VERSION,
        "id": request_id,
        "ok": False,
        "error": {"code": code, "message": message},
    }


HANDLERS = {
    "sys.hello": Bridge.sys_hello,
    "sys.ping": Bridge.sys_ping,
    "sys.info": Bridge.sys_info,
    "gpio.mode": Bridge.gpio_mode,
    "gpio.read": Bridge.gpio_read,
    "gpio.write": Bridge.gpio_write,
    "gpio.toggle": Bridge.gpio_toggle,
    "gpio.watch": Bridge.gpio_watch,
    "adc.read": Bridge.adc_read,
    "pwm.configure": Bridge.pwm_configure,
    "pwm.write": Bridge.pwm_write,
    "gpio.servo": Bridge.gpio_servo,
    "i2c.scan": Bridge.i2c_scan,
    "i2c.read": Bridge.i2c_read,
    "i2c.write": Bridge.i2c_write,
    "spi.transfer": Bridge.spi_transfer,
}


def process_line(bridge, line, emit):
    """Parse one input line and emit zero or one response lines."""
    line = line.strip()
    if not line or not line.startswith("{"):
        return  # ignore: keepalive noise, echoes, partial lines
    try:
        request = json.loads(line)
    except ValueError:
        emit(json.dumps(_failure("invalid", "INVALID_JSON", "Request is not valid JSON.")))
        return
    if not isinstance(request, dict):
        emit(json.dumps(_failure("invalid", "INVALID_MESSAGE", "Request must be a JSON object.")))
        return
    if request.get("v") != PROTOCOL_VERSION:
        emit(json.dumps(_failure("invalid", "INVALID_MESSAGE", "Unsupported protocol version.")))
        return
    if not isinstance(request.get("id"), str) or not isinstance(request.get("action"), str):
        emit(
            json.dumps(
                _failure("invalid", "INVALID_MESSAGE", "Request must include string id and action.")
            )
        )
        return
    emit(json.dumps(handle_request(bridge, request)))


def run_stdio(bridge):
    """Host/simulation mode: request lines on stdin, responses on stdout."""

    def emit(text):
        sys.stdout.write(text + "\n")
        sys.stdout.flush()

    for line in sys.stdin:
        process_line(bridge, line, emit)


def _sleep_ms(milliseconds):
    """MicroPython time.sleep_ms with a CPython fallback (host simulation)."""
    if hasattr(time, "sleep_ms"):
        time.sleep_ms(milliseconds)
    else:
        time.sleep(milliseconds / 1000.0)


def run_uart(bridge):
    """Hardware mode: NDJSON over a UART."""
    if not hasattr(machine, "UART"):
        raise UnsupportedCapability("UART transport requires machine.UART")
    try:
        uart = machine.UART(UART_ID, baudrate=UART_BAUD, tx=UART_TX_PIN, rx=UART_RX_PIN)
    except TypeError:
        uart = machine.UART(UART_ID, baudrate=UART_BAUD)
    buffer = b""

    def emit(text):
        uart.write((text + "\n").encode())

    while True:
        waiting = uart.read()
        if waiting:
            buffer += waiting
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if len(line) > LINE_MAX:
                    continue  # oversized frame: drop just that line
                process_line(bridge, line.decode("utf-8", "replace"), emit)
        _sleep_ms(2)


def main():
    bridge = Bridge()
    if HARDWARE and TRANSPORT == "uart":
        run_uart(bridge)
    else:
        # A named hardware profile announces its identity before serving USB CDC.
        if HARDWARE and BOARD_ID:
            ready = {"v": PROTOCOL_VERSION, "event": "ready", "payload": bridge.sys_hello({})}
            sys.stdout.write(json.dumps(ready) + "\n")
            sys.stdout.flush()
        # MicroPython USB CDC and host validation both expose stdin/stdout.
        run_stdio(bridge)


if __name__ == "__main__":
    main()
