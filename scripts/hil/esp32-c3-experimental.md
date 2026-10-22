# ESP32-C3 experimental HIL procedure

Build `pio run -e esp32-c3-supermini`, then flash only after confirming the
board's native USB connector and silkscreen. Verify that opening the CDC port
does not unexpectedly enter download mode, that `sys.hello` fallback works,
and that flash pins 11-17 and USB pins 18-19 are refused. Record the same
identity, version, wiring, and raw protocol evidence as the classic procedure.
This target is `COMPILE_TESTED`; physical HIL remains pending until a dated observation record exists. GPIO 2/8/9 are also reserved boot straps. Use an external LED on GPIO 4 and follow the [three-board demo](../../docs/three-board-demo.md).
