# Protocol v1 golden vectors

The first four lines in `messages.jsonl` are complete NDJSON frames. They are
the wire contract shared by the TypeScript host, simulator, and firmware
bridge. The remaining records are malformed-input fixtures with an `input`
and an expected structured error code. A generated oversized input is marked
as `decode: "message"` because the JSON is valid; the frame-size boundary
rejects it before dispatch.

`unknown-action` deliberately decodes as a request. Action/schema validation
belongs to the device dispatcher, which must reject it with `UNKNOWN_ACTION`
before any actuation. Unknown/non-JSON boot logging is intentionally outside
the vectors and must be ignored by hosts.
