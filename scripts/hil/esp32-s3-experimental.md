# ESP32-S3 experimental HIL procedure

Build `pio run -e esp32-s3-devkitc-1`, then flash only after confirming the
board silkscreen (DevKitC-1 / ESP32-S3-WROOM) and the USB connector you intend
to use (native USB CDC vs UART bridge). Verify that opening the CDC port does
not unexpectedly enter download mode, that `sys.hello` reports
`boardId: "esp32-s3-devkitc-1"`, and that reserved pins are refused:

- flash / reserved block 22–33
- USB 19–20
- UART0 43–44
- strap 45–46

Use an external LED on GPIO 2 or 4. Record the same identity, version, wiring,
and raw protocol evidence as the classic procedure.

This target is `COMPILE_TESTED`; physical HIL remains pending until a dated
observation record exists under `hardware/records/`. See also
[firmware/esp32-bridge/README.md](../../firmware/esp32-bridge/README.md) and
[firmware/boards/esp32-s3-devkitc-1.json](../../firmware/boards/esp32-s3-devkitc-1.json).
