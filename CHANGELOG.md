# Changelog

## Unreleased

- Fix Homebridge night-mode contrast for custom settings text, fields, help, tables, and buttons. Follow Homebridge's selected theme even when the operating system uses a different appearance.
- Add browser checks for light/night theme switching, text and field-border contrast, and mobile layout.

## 0.1.2

- Log successful HomeKit On/Off/native Reboot command acceptance and power-aware no-op requests at info level, identifying the PDU and outlet.
- Log confirmed power-aware recovery once and warn when its verification window expires. Uncertain commands never log acceptance or an invented reboot success.
- Add debug-only HomeKit read results, cache/shared-refresh diagnostics, source-labelled status requests, and successful startup/polling checks.
- Guard informational and debug logging so a failing logger cannot change an accepted hardware action into a reported failure or trigger a retry.
- Document logging levels and add regression tests for success, uncertainty, no-ops, recovery, and unchanged session counts.

## 0.1.1

- Fixed unhandled status callback failures that could leave requests unresolved. Both synchronous exceptions and rejected callback promises are isolated, logged safely, and do not block other outlets or turn successful operations into PDU failures.
- Guarded platform startup and cleanup. Failed accessory setup stops partial controllers, preserves cached accessories, and marks affected switches unavailable. Polling begins only after setup succeeds.
- Guarded reboot recovery callbacks and background tasks while preserving read-only recovery and native PDU reboot behavior.
- Added regression coverage for callback, startup, cleanup, and logging failures, including credential-safe diagnostics.
- Added the plugin icon above the README title. No configuration migration is required.

## 0.1.0

- First stable release, promoting the beta.2 functionality without changing outlet behavior or configuration.
- Normal On/Off and power-aware reboot switches for one or more RPC PDUs, with direct Telnet control and native autonomous reboot.
- Homebridge UI configuration, read-only connection previews, shared status caching, and adjustable polling/recovery timers.
- Installation instructions now use the stable npm `latest` channel, including migration from beta installations.
- Added a checked stable release script that publishes the tested npm archive and creates the matching GitHub release.

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
