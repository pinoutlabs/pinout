# Pinout Python SDK

The official Python client for [Pinout](https://github.com/IMisbahk/pinout) —
the interface between intelligence and physical machines.

Talks to a running [`pinoutd`](../../docs/daemon.md) daemon over its local HTTP
API. Install:

```bash
pip install pinout          # sync client, stdlib only
pip install pinout[async]   # + asyncio client (httpx)
```

## Quick start (sync)

```python
from pinout import Pinout

p = Pinout()                       # PINOUT_DAEMON_URL / PINOUT_URL / PINOUT_TOKEN / PINOUT_OWNER env-aware
arm = p.device("arm-01")

print(arm.state())
print(arm.capabilities())

# Immediate invocation
result = arm.invoke("gripper.close", {"force": 20}, wait=True)

# Long-running invocation: get an Operation handle
op = arm.invoke("motion.move_to", {"x": 0.1, "y": 0.0, "z": 0.3})
for progress in op.progress():
    print(progress)
result = op.result()

# Preview policy-resolved requests without physical side effects
print(arm.invoke("motion.move_to", {"x": 0.1}, dry_run=True))
```

## Async

```python
from pinout.async_client import AsyncPinout

async with AsyncPinout() as p:
    op = await p.invoke("arm-01", "motion.home")
    result = await p.operation_result(op["id"])
    async for event in p.events():
        print(event)
```

## Read a simulator snapshot

Start a local demo daemon in another terminal (`node
packages/daemon/dist/main.js --demo --token local-demo-token`) and export
`PINOUT_TOKEN=local-demo-token`. The SDK's public read-only snapshot call is
`Device.state()`; capability names come from `Device.capabilities()`.

```python
from pinout import Pinout
from pinout.errors import UnsupportedCapability

p = Pinout(owner="python-docs")
device = p.device("esp32-01")
snapshot = device.state()  # read-only; it does not actuate the simulator
print("state:", snapshot)
print("capabilities:", ", ".join(device.capabilities()))

try:
    device.invoke("missing.capability", {})
except UnsupportedCapability as error:
    print(error.code)  # UNSUPPORTED_CAPABILITY
```

The simulator makes this example runnable without hardware. A simulated
snapshot is useful for exercising client logic, but it is not evidence that a
physical device is safe or that an output changed.

## Safety

```python
p.halt("maintenance window")       # reject all physical invocations
p.estop("operator request")        # software estop request (sticky)
p.clear_estop()
p.resume("all clear")
```

> Software halt/estop coordinates the runtime's response. It is **not** a
> certified emergency-stop system; independent hardware safeguards are always
> required for machinery.

## Errors

Typed exceptions with stable codes — never parse prose:

```python
from pinout.errors import UnsupportedCapability, PolicyRejected, LeaseConflict

try:
    arm.invoke("motion.move_to", {"x": 999})
except UnsupportedCapability as err:
    ...
except PolicyRejected as err:
    print(err.code, err.details)
```

## Tests

```bash
pip install -e .[dev]
pytest
```

The test suite runs against an in-process mock daemon; no Node runtime or
hardware is required.
