# homebridge-rpc3control: implementation plan

Date: 2026-09-10. Status: agreed architecture; implementation pending.

## Goal and locations

Public Homebridge platform plugin for one or more BayTech RPC PDUs. Configure devices and outlets through Homebridge UI.
Repository: pponce/homebridge-rpc3control. Branch: main.
Development folder: ~/devProjects/homebridge-rpc3control.
Existing local reference: /var/lib/homebridge/rpc3control. Keep this installation separate.
Use TypeScript compiled to JavaScript with direct Telnet communication. No Script2, Python, Pexpect, nexpect, or external Telnet executable at runtime.

## Hardware scope

Only the owned eight-outlet RPC unit is available for hardware testing. Other units are assumed to share the Telnet UI and four-concurrent-session limit. Label them unverified until user feedback; do not block release on acquiring other units.
Require a positive outletCount per PDU and validate outlet numbers against it. Remove fixed eight-outlet limits. Test other counts and multiple PDUs using simulated devices.
Read the local Python reference before porting. Preserve any existing model-specific handling as correct. The reviewed GitHub version has one RPC-3 prompt path and eight-outlet bounds, with optional-login handling; no explicit model-selection branches were found.

## Configuration and accessories

PDU settings: stable ID, name, host, port (default 23), optional username/password, outletCount, polling interval, cache TTL, connection timeout, and operation timeout.
Outlet settings: physical number, name, and mode (power or reboot). Omitted outlets are not exposed. Reboot mode adds positive resetAfterMs, proposed default 3000 ms.
Reject duplicate PDU IDs, duplicate endpoint entries where identifiable, and duplicate outlet numbers within a PDU. Derive accessory identity from PDU ID, outlet number, and control role rather than name or list order.

## Stateful power switches

Use writable HomeKit Switch services. On sends native on N; Off sends native off N. Read actual outlet state from the PDU.
After a write, invalidate the shared PDU cache and schedule one verification read. Keep requested and confirmed states distinct. Missing or failed reads mean unknown/unreachable, never Off.

## Momentary reboot switches

Use a writable HomeKit Switch, not StatelessProgrammableSwitch. Turning it On queues exactly one native reboot N command, which the existing controller supports.
The PDU performs the off/on cycle. Never implement reboot as separate off and on commands with a plugin timer.
Show On while pending. After command acceptance, reset the displayed switch to Off after resetAfterMs. This delay controls only the switch display, not the physical power-off duration.
Internal reset and user Off writes must not send hardware commands. User Off does not cancel an accepted reboot or clear duplicate suppression.
Suppress duplicate On requests while pending or awaiting reset. On failure, clear the display and report the error. After a timeout or disconnect following transmission, treat the outcome as uncertain and never automatically replay reboot.
Acceptance does not prove that attached equipment has finished booting. Initialize reboot switches Off after restart; never replay old requests. Clear timers at shutdown.

## Telnet protocol

Evaluate the telnet-client npm library against the existing protocol. Keep transport separate from controller and HomeKit code.
Preserve banner handling, carriage-return wakeup, optional Enter username> and Enter password>, Enter Selection>, menu selection 1, status/help output, RPC-3>, on/off/reboot N, MENU, and logout selection 6.
Track consumed prompts explicitly rather than copying accidental double-waits. Connected to is output from the old Telnet executable; direct connection success comes from the socket.
Handle Telnet negotiation, echo, line endings, prompts without newlines, split network chunks, bounded receive buffering, and structured status parsing. Preserve existing supported formats. Bound connection, operation, queue, and cleanup time.

## Queues, caching, and recovery

One controller, queue, and shared status cache per PDU. At most one active plugin session per PDU, leaving capacity under the assumed device-wide four-session limit. Different PDUs can operate concurrently.
Serialize complete login/operation/logout transactions. Initially use short-lived sessions and always close sockets after success or failure.
Coalesce status requests across outlets. Prioritize user commands over queued polling without interrupting active transactions. Stagger polling and back off after failures. Avoid reconnect storms and blind retries of uncertain writes.
Use in-memory coordination rather than the legacy shared cache file. Isolate failures between PDUs. Cancel timers, reject pending work, and close sockets at shutdown. Redact credentials and never commit real configuration.

## Implementation and validation

1. Initialize repository with this plan, README, and ignore rules; no live installation changes.
2. Scaffold a current Homebridge TypeScript platform plugin with supported Node/Homebridge versions, package metadata, license, build, lint, tests, and UI schema. Retain applicable third-party notices.
3. Build a simulated Telnet PDU and sanitized protocol fixtures. Implement transport, parsing, per-PDU queues, cache, and cleanup.
4. Add validated configuration, stable accessories, stateful power control, and reboot timers.
5. Test optional login, split prompts, malformed/missing status, multiple simulated PDUs, configurable counts, session limits, cache coalescing, timeouts, and failure isolation.
6. Test reboot exactly once, reset timing, duplicate suppression, Off/reset sending no command, uncertain outcomes without replay, accessory identity, mode changes, and shutdown.
7. Validate actual status, power control, and native reboot on the owned eight-outlet unit with a selected noncritical load. Coordinate actions affecting the SSH host or network. Other-model hardware testing waits for users.
8. Document setup, compatibility assumptions, troubleshooting, and feedback. Test a packed npm artifact in clean Homebridge without Python or Telnet installed. Include compiled JavaScript. npm publication is a separate release step.

## References

- [Existing controller](https://github.com/pponce/rpc3control/blob/master/rpc3Control.py)
- [Homebridge template](https://github.com/homebridge/homebridge-plugin-template)
- [Telnet client](https://github.com/mkozjak/node-telnet-client)
