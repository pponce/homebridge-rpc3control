# Changelog

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
- Physical PDU validation, live Homebridge validation, and npm publication pending.
