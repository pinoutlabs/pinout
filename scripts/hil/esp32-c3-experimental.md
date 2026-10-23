# ESP32-C3 experimental HIL procedure

Build `pio run -e esp32-c3-supermini`, then flash only after confirming the
board's native USB connector and silkscreen. Verify that opening the CDC port
does not unexpectedly enter download mode, that `sys.hello` reports
`boardId: "esp32-c3-supermini"`, and that reserved pins are refused:

- flash 11–17
- USB 18–19
- UART0 20–21
- strap 2 / 8 / 9

Record the same identity, version, wiring, and raw protocol evidence as the
classic procedure. This target is `COMPILE_TESTED`; physical HIL remains
pending until a dated observation record exists. Use an external LED on GPIO 4
and follow the [three-board demo](../../docs/three-board-demo.md).
Pinout never auto-flashes — upload only with an explicit
`pio run -e esp32-c3-supermini -t upload --upload-port PORT` after identity
confirmation.
