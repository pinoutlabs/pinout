# Safety model

Pinout applies schema validation, capability policy, leases, operation
idempotency, stale-state checks, explicit arming, command heartbeats, and journal records below an agent. The daemon
is the actuation authority and the CLI/MCP/Python surfaces are clients of that
control plane.

The normal pipeline is:

1. Discover and inspect capabilities (read-only).
2. Configure per-output safe-state tables (`gpio.configSafeState`) matching electrical circuit topology (safe levels and polarity).
3. Acquire a scoped lease for the physical capability.
4. Validate a request and run a non-actuating dry-run.
5. Explicitly arm the device (`sys.arm`) and start the deadman heartbeat watchdog (`watchdog.kick`).
6. Start an idempotent operation with progress and an audit record.
7. Release the lease, or enter `HALTED` on emergency stop/fault, or `disarmed` on completion.

## Device-Local Host-Loss Watchdog and Circuit-Aware Safe State

1. **Deadman Watchdog (`watchdog.kick`)**:
   When armed, the host must continuously send heartbeats within the negotiated timeout window (`watchdog.configure`). If the host crashes, hangs, or the link is severed, the device firmware locally triggers safe state upon timeout without requiring host intervention.
2. **Circuit-Aware Safe State**:
   Safe state is not assumed to be electrical LOW. Output commissioning requires declaring the fail-safe level (`low`, `high`, `high-z`, or `hold`) and load polarity (`active-high` vs `active-low`). For example, active-low relays are driven HIGH when safe state is applied, preventing dangerous de-energization inversion.
3. **Explicit and Governed Arming (No Implicit Auto-Arming)**:
   Boot, watchdog timeout, link drops, reconnects, and hardware resets always leave the device in the `disarmed` or `tripped` state. Actuation commands sent while disarmed or tripped are rejected with `NOT_ARMED` or `WATCHDOG_TRIPPED`. No code path may arm implicitly on invoke. Arming is an explicit, safety-governed action reachable via `pinout arm <deviceId>`, MCP tool `sys_arm`, or `runtime.invoke(id, 'sys.arm', {})` requiring lease ownership and journal recording. `autoArm` options in backends are strictly demo/test-only and emit logger warnings.
4. **Bounded Command Validity**:
   Commands may carry a `validityMs` TTL. Buffered or delayed commands exceeding their TTL are rejected with `COMMAND_EXPIRED`.
5. **Legacy Firmware Guarantees**:
   The host SDK inspects the firmware identity `features` array. Older firmware lacking `watchdog` and `arming` flags is treated as unsupported for safety-critical actuation.
6. **Host fail-safe on authority loss (daemon)**:
   When a lease expires or the host deadman heartbeat goes stale, `pinoutd` (default ON) disarms and applies backend `safeState`, journaling the event. Arming requires an active lease. This runs while the daemon process is alive (e.g. agent paused mid-MCP tool call). The firmware watchdog remains mandatory if the host crashes or the link is severed — see [Infinity + MCP](infinity.md).

## Verification Status

Simulation, compile tests, and protocol acknowledgements do not establish
physical safety, certification, timing guarantees, or suitability for mains
loads.

**Current status**: Protocol, SDK, firmware logic, and simulator state machines are verified in software unit and integration test suites. Physical hardware acceptance tests (hardware E-stop timing, physical link severance, active-low relay fixtures) remain pending hardware bench tests and dated records under `hardware/records/`.
