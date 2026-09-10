# homebridge-rpc3control

A Homebridge platform plugin for one or more BayTech RPC PDUs using direct Telnet from TypeScript. Each configured outlet appears as a stateful power switch or a momentary native reboot switch.

**0.1.0-beta.1 development preview. Not published to npm.** Automated tests use simulated PDUs. Validation on the developer's physical eight-outlet RPC unit is pending. Other models are assumed to share the RPC menu and four-session limit but are not hardware-verified.

## Features

- Power On sends `on N`; Off sends `off N`. Confirmed status comes from the PDU.
- Reboot sends **one native `reboot N` command**. The PDU handles power off and back on; a separate timer resets only the displayed switch.
- Independent queues and shared status caches for multiple PDUs, with at most one active plugin session per PDU.
- No Python, Pexpect, Script2, Telnet executable, or runtime npm dependencies. Uses Node's TCP networking and an incremental Telnet parser.

The reboot reset delay does not change the physical power-off duration or indicate when equipment finishes booting. The plugin never substitutes a delayed `off`/`on` pair for native reboot.

## Requirements and development installation

Use Node 22.13+ within version 22, or Node 24; Homebridge 1.8+ within version 1, or Homebridge 2.x. Homebridge must reach the PDU's Telnet port, normally TCP 23.

```bash
git clone git@github.com:pponce/homebridge-rpc3control.git
cd homebridge-rpc3control
npm install
npm test
npm link
```

For an existing checkout, run `git pull --ff-only` there first. `npm install` builds through `prepare`. Use the Node/npm installation and global npm prefix used by the Homebridge service; a link under another user's Node installation will not be discovered. Configure the plugin, then restart Homebridge through its UI.

`npm pack` creates `homebridge-rpc3control-0.1.0-beta.1.tgz` containing compiled JavaScript. Install this archive using npm in the Homebridge installation's plugin prefix. Archive consumers need no TypeScript or development dependencies. GitHub Actions uploads a package artifact after successful validation.

The package remains `private: true` until hardware validation and an explicit npm release. This repository does not automatically publish or modify a live Homebridge installation.

## Configuration

Use **RPC PDU Control** in Homebridge UI or add this entry to the Homebridge `platforms` array:

```json
{
  "platform": "Rpc3Control",
  "name": "RPC PDU Control",
  "pdus": [
    {
      "id": "rack-main",
      "name": "Main rack",
      "host": "192.0.2.10",
      "port": 23,
      "username": "admin",
      "password": "",
      "outletCount": 8,
      "outlets": [
        { "number": 2, "name": "Desk Power", "mode": "power" },
        { "number": 3, "name": "Test Device Reboot", "mode": "reboot", "resetAfterMs": 3000 }
      ]
    }
  ]
}
```

Replace the example address and credentials. Add one `pdus` entry per device. Credentials are sent only when requested, and are not stored in accessory context or logs. Telnet itself is unencrypted; use a trusted local network.

### PDU settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `id` | Required | Permanent unique ID: 1-64 letters, digits, `_` or `-`. Changing it recreates accessories. |
| `name` | ID | Display/log name. |
| `host` | Required | IP address or hostname, without scheme or port. |
| `port` | `23` | Telnet TCP port. |
| `username`, `password` | Empty | Optional printable ASCII credentials; spaces are preserved. |
| `outletCount` | Required | Total physical outlets, 1-256. This is a software limit, not a compatibility claim. |
| `outlets` | Required list | Outlets to expose. Omitted outlets are not changed or registered. |
| `pollingIntervalMs` | `60000` | Recurring status interval; `0` disables it, otherwise minimum 5000 ms. |
| `cacheTtlMs` | `15000` | Confirmed status reuse duration; `0` requires refresh. |
| `connectTimeoutMs` | `3000` | Connection deadline. |
| `operationTimeoutMs` | `8000` | Whole login/operation session deadline. |
| `queueTimeoutMs` | `3000` | Maximum wait before starting. Expired queued commands are not sent. |

PDUs with power switches receive an initial status read even if recurring polling is disabled. Reads after cache expiry share a refresh. Reboot-only PDUs are not routinely polled. Long timeouts can exceed HomeKit's response deadline; start with defaults. Pending queue depth is bounded at 32, response buffers at 64 KiB.

### Outlet settings

| Setting | Meaning |
| --- | --- |
| `number` | Physical number, 1 through the PDU's `outletCount`. |
| `name` | Switch name in Home. |
| `mode` | `power` or `reboot`; one mode per configured outlet in this version. |
| `resetAfterMs` | Reboot display reset delay after acceptance; default 3000 ms, range 100-3600000 ms. Ignored for power mode. |

Identity uses PDU ID, number, and mode. Renaming/reordering preserves identity; changing mode replaces the accessory and may require updating Home automations. Removing an outlet or PDU from valid configuration removes its accessories. Invalid configuration preserves cached accessories but makes their handlers unavailable.

## Commands and outages

- Complete login/operation/logout transactions are serialized per PDU. Other clients still share the assumed four-session device limit.
- User writes take precedence over pending polling; writes remain FIFO. Reads are coalesced across outlets.
- Writes invalidate the cache and request shared verification. Requested HomeKit values and confirmed controller state are distinct.
- Missing rows and failed reads produce communication errors, not an invented Off state. Home may retain its last display until processing an update/error.
- Failures trigger a 5-second cooldown, doubling up to 5 minutes. Queued work fails rather than creating reconnect storms. Later reads/polls reconnect after cooldown.
- Writes are never automatically retried. A timeout/disconnect after transmission means **uncertain**: the PDU may have acted. Check before manually repeating a reboot.
- Duplicate reboot requests are suppressed while pending or awaiting reset. User Off has no physical effect and does not cancel the reboot or clear suppression. Home may briefly display its Off request; reads still reflect the active guard until reset.
- Restart initializes reboot switches Off without replaying commands. Shutdown cancels queued work and closes active connections.

## Verification

```bash
npm run lint
npm test
npm pack
node scripts/check-package.mjs
```

`lint` performs strict TypeScript checks including unused code. Tests use Node's test runner and local TCP servers, never physical PDUs. They cover optional login, wakeup/menu fallback, fragmented negotiation/prompts, configurable counts, parsing, queue/cache races, failures, deadlines, reboot timers/suppression, and accessory lifecycle with a simulated Homebridge API.

The package check extracts the archive into an isolated directory and checks loading/registration without installed runtime dependencies. CI runs compiler checks, tests, and packaging on Node 22 and 24. Simulated API tests and package loading do not replace a complete live Homebridge/Home app test.

### Hardware validation still required

On the owned eight-outlet unit, use a selected noncritical load to verify status, On/Off, one native reboot, its separate display reset, duplicate suppression, temporary outages, and identity after restart. Coordinate tests that could affect the SSH host or network. Avoid running the legacy integration against the same outlets during initial validation. Other models will be assessed when users provide feedback and sanitized output.

## Protocol reference

Based on [pponce/rpc3control](https://github.com/pponce/rpc3control/blob/master/rpc3Control.py), reviewed blob `62060ec220186c68c9b5665b0d75aa5efe9a12b4`: optional login, selection `1`, RPC prompt, `on/off/reboot N`, `MENU`, logout `6`. The third numeric field remains the physical outlet number; names with spaces are also accepted. A returned RPC prompt without a recognized error means acceptance, subject to hardware validation.

The GitHub reference has one RPC-3 path, not explicit per-model branches. Numeric RPC model suffixes are accepted under the same-UI assumption. The developer-local reference folder is inaccessible from the implementation environment; unpushed differences have not been compared.

[telnet-client](https://github.com/mkozjak/node-telnet-client/blob/master/src/index.ts) was evaluated. Its inspected login/negotiation paths make chunk-boundary assumptions, so this plugin uses a bounded incremental parser built on Node's standard library. It handles embedded/split IAC negotiation, echo, suppress-go-ahead, escaped IAC, and rejected unsupported options under [RFC 854](https://www.rfc-editor.org/rfc/rfc854). It does not emulate a general terminal or automatically answer confirmation/pagination prompts absent from the reference UI.

See [PLAN.md](PLAN.md) for agreed scope and implementation status.
