# Changelog

## 0.1.0-beta.2

- Added npm beta installation instructions for Homebridge UI and `hb-service add`; moved contributor guidance to DEVELOPMENT.md.
- Added a checked beta-publishing script and public beta publication defaults.

- **Behavior change:** `reboot` is now Power-aware reboot. It displays actual power state; On powers up an Off outlet, and Off reboots an On outlet. Matching requests are no-ops. Update beta.1 Siri/scenes that previously requested On to reboot.
- Fresh-state decision and native command share one queued Telnet session. Missing status prevents action.
- Reboot always uses native `reboot N`: the PDU restores power autonomously through network loss. No timer sends an On command and uncertain writes are never automatically replayed.
- Delayed, bounded, read-only recovery restores the displayed On state after confirmation, including with polling disabled. Duplicate/opposite writes are rejected during recovery.
- `resetAfterMs` is retained as the recovery check delay. Both modes now perform startup discovery and honor normal status polling.
- Added protocol, HomeKit, network-loss, backoff, shutdown, and UI regression checks.

## 0.1.0-beta.1

- Initial TypeScript platform plugin and Homebridge UI configuration schema.
- Custom settings screen with PDU cards, advanced sections, conditional reboot fields, and timing in seconds.
- Missing-outlet generation that preserves existing settings, and automatically generated stable PDU IDs.
- Read-only connection/status preview with a deadline, cooldown, and no power commands.
- Official Homebridge UI helper dependency, packaged UI assets, and browser/IPC regression checks.
- Direct buffered Telnet transport with no external runtime dependencies.
- Independent PDU queues, configurable outlet counts, shared status caches.
- Stateful power and native reboot switches with configurable display reset timers.
- Deadlines, cleanup, backoff, uncertain-write reporting, duplicate suppression.
- Simulated PDU/Homebridge tests and npm package smoke validation.
- Published as the initial npm beta. Physical PDU and live Homebridge validation remain pending.
