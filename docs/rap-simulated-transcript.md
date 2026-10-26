# RAP adapter SIMULATED transcript

Evidence: **SIMULATED**. Ran `pinoutd --demo` + `@pinout/rap` against a mock RAP callback runtime in this VM.

## Why not Infinity?

This VM has Rust/`cargo` but **not** the Infinity CLI or a configured model provider.
Building `github.com/hydro-project/infinity` end-to-end also needs provider credentials (Bedrock/Anthropic/etc.).
Verification here uses the package mock RAP runtime + this demo transcript instead.

## Transcript

```
[2026-10-26T10:29:27.249Z] daemon: [pinout:info] connected {"sessionId":"2527356d-e59a-432c-a350-f0a8c9d8ae03","transport":"simulated-esp32","firmware":"esp32-bridge"}
[2026-10-26T10:29:27.256Z] daemon: pinoutd v0.0.1-alpha.1 listening on http://127.0.0.1:18787 (loopback only)
Generated daemon token in /tmp/pinout-rap-sim-l0sGCs/pinoutd.json; retrieve it from that 0600 file.
[2026-10-26T10:29:27.345Z] pinoutd ready (SIMULATED demo devices) tokenBytes=64
[2026-10-26T10:29:27.450Z] rap: [pinout-rap] listening on http://127.0.0.1:18791 (toolset http://127.0.0.1:18791/.well-known/rap-toolset)
[2026-10-26T10:29:27.557Z] toolset status=200 name=pinout tools=12 endpoint=http://127.0.0.1:18791/invoke
[2026-10-26T10:29:27.561Z] INVOKE ack status=200 dtMs=4 op=pinout__list_devices id=call_list
[2026-10-26T10:29:27.577Z] CALLBACK tool_result id=call_list text="{\"devices\":[{\"id\":\"esp32-01\",\"deviceClass\":\"microcontroller\",\"moduleId\":\"pinout/esp32\",\"activeTransportKind\":\"simulated-"
[2026-10-26T10:29:27.586Z] list_devices sample={"devices":[{"id":"esp32-01","deviceClass":"microcontroller","moduleId":"pinout/esp32","activeTransportKind":"simulated-esp32","lifecycle":"ready","simulated":true,"stateEvidence":{"armed":{"commanded
[2026-10-26T10:29:27.589Z] INVOKE ack status=200 dtMs=3 op=pinout__acquire_lease id=call_lease
[2026-10-26T10:29:27.593Z] CALLBACK tool_result id=call_lease text="{\"lease\":{\"id\":\"lease_1_d5qk5u\",\"mode\":\"exclusive\",\"scope\":{\"kind\":\"device\",\"deviceId\":\"esp32-01\"},\"owner\":\"sim-thread-1"
[2026-10-26T10:29:27.617Z] INVOKE ack status=200 dtMs=2 op=pinout__dry_run id=call_dry
[2026-10-26T10:29:27.621Z] CALLBACK tool_result id=call_dry text="{\"dryRun\":true,\"deviceId\":\"esp32-01\",\"capability\":\"gpio.write\",\"resolvedArgs\":{\"pin\":2,\"value\":true},\"haltState\":\"NORMAL"
[2026-10-26T10:29:27.644Z] INVOKE ack status=200 dtMs=2 op=pinout__invoke id=call_arm
[2026-10-26T10:29:27.652Z] CALLBACK view_update id=- text=""
[2026-10-26T10:29:27.652Z] CALLBACK tool_result id=call_arm text="{\"operation\":{\"id\":\"op_1_iclcvu1s\",\"deviceId\":\"esp32-01\",\"capability\":\"sys.arm\",\"status\":\"completed\",\"idempotencyKey\":\"s"
[2026-10-26T10:29:27.671Z] INVOKE ack status=200 dtMs=1 op=pinout__invoke id=call_invoke
[2026-10-26T10:29:27.676Z] CALLBACK view_update id=- text=""
[2026-10-26T10:29:27.676Z] CALLBACK tool_result id=call_invoke text="{\"operation\":{\"id\":\"op_2_3x9ynt56\",\"deviceId\":\"esp32-01\",\"capability\":\"gpio.write\",\"status\":\"completed\",\"idempotencyKey\""
[2026-10-26T10:29:27.698Z] close_thread status=200
```
