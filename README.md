# homebridge-rpc3control

![BayTech RPC power distribution unit](https://raw.githubusercontent.com/pponce/homebridge-rpc3control/main/assets/BayTech-PDU-Shot.jpg)

A Homebridge platform plugin for one or more BayTech RPC PDUs using direct Telnet from TypeScript. Each configured outlet appears as a stateful power switch or a power-aware native reboot switch.

**0.1.0-beta.2 development preview. Not published to npm.** Automated tests use simulated PDUs. Validation on the developer's physical eight-outlet RPC unit is pending. Other models are assumed to share the RPC menu and four-session limit but are not hardware-verified.

## Old hardware, new tricks

Your BayTech RPC may come from the era of terminal windows and blinking rack lights, but it still has plenty of switches left to flip. Retirement? Let's give it a HomeKit invitation instead.

This plugin brings that old workhorse into the Home app: tap to control an outlet, ask Siri to switch it on, or give a stubborn device a native power-cycle reboot. The PDU keeps speaking Telnet; Homebridge handles the introductions. No new smart power strip or PDU cloud account required.

Same sturdy metal box. Same satisfying relay clicks. A few decidedly modern party tricks.

## Features

- Power On sends `on N`; Off sends `off N`. Confirmed status comes from the PDU.
- **Power-aware reboot** displays actual outlet state. Request On while Off to power up; request Off while On to send **one native `reboot N` command**. The PDU handles power off and back on, even if that interrupts the network path.
- Independent queues and shared status caches for multiple PDUs, with at most one active plugin session per PDU.
- No Python, Pexpect, Script2, or Telnet executable. PDU control uses Node's TCP networking and an incremental Telnet parser. The settings server uses the official `@homebridge/plugin-ui-utils` package, installed automatically by npm.
- Custom Homebridge settings with PDU cards, outlet generation, conditional reboot controls, and a read-only connection/status preview.

## What power-aware reboot does

Both switch options display the actual outlet power state. **Power (On / Off)** behaves like a normal power switch. **Power-aware reboot** has these actions:

| Confirmed outlet state | HomeKit request | PDU action |
| --- | --- | --- |
| Off | On | Native `on N` to power up. |
| On | Off | Native `reboot N` to cycle power. |
| On | On | No power command; already On. |
| Off | Off | No power command; already Off. |

The plugin checks fresh outlet status in the same queued Telnet session before choosing the action. Unknown status means no power action. The internal action names `ensure-on` and `reboot-if-on` are never sent to the PDU.

**Turning this switch Off means reboot, including Siri requests, scenes, and “turn everything off” automations.** Use the normal Power option when you need to leave an outlet switched off.

### Rebooting network equipment

The plugin sends the PDU’s native `reboot N` command, never an `off N` followed by a timer-driven `on N`. Once the PDU has received and accepted the native command, its own controller completes the off/on cycle without needing an internet connection, an Ethernet connection to Homebridge, or a running Homebridge process. This is essential when rebooting the switch/router carrying that connection, or the host running Homebridge itself.

If the connection drops after transmission, the command may have been accepted even though its reply was lost. The plugin reports that uncertainty and **does not automatically resend reboot**. If the PDU never received the command, the plugin cannot guarantee that a reboot occurred.

The HomeKit switch returns to **On when a subsequent status read confirms power is On**. During the cycle it can show Off if that is the confirmed state, or No Response while the PDU is unreachable. It never assumes success just because a timer expired. Power On does not mean the attached router/server has finished booting.

After an accepted or uncertain action, the plugin waits for the configured **Recovery check delay** (default 3 seconds), then performs read-only verification. Further checks back off through 5, 10, 20, 40, and 60 seconds, with at most ten minutes of recovery attempts after the initial delay. Normal PDU failure cooldown also applies. Recovery works with regular polling disabled and stops when On is confirmed. Repeated/opposite writes are rejected while the action is pending or recovery is active, so an extra tap cannot interrupt the native cycle. After the recovery window expires, background recovery stops and a later user request checks fresh state again. Timers never send power commands.

### Upgrading from beta.1

**beta.2 replaces the momentary reboot behavior.** The stored mode remains `reboot`, preserving accessory identity, but an existing reboot switch now displays power state and reboots on an **Off** request while the outlet is On. Update any Siri phrases, scenes, or automations that previously requested On to reboot.

The legacy JSON key `resetAfterMs` is retained, but now means **delay before checking recovery**, not a forced display reset. Its UI label is “Recovery check delay.” After restart, both modes discover real state; no saved reboot request is replayed.

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

`npm pack` creates `homebridge-rpc3control-0.1.0-beta.2.tgz` containing compiled JavaScript. Install this archive using npm in the Homebridge installation's plugin prefix. Archive consumers need no TypeScript or development dependencies. GitHub Actions uploads a package artifact after successful validation.

The package remains `private: true` until hardware validation and an explicit npm release. This repository does not automatically publish or modify a live Homebridge installation.

## Configuration

Open **RPC PDU Control → Settings** in Homebridge UI:

1. **Add PDU**, give it a name, and enter its IP address and total physical outlet count.
2. Expand **Login credentials** if your PDU requires them.
3. Click **Add missing outlets** to create entries for the configured physical numbers. Existing names, behavior, and delays are preserved. Remove entries you do not want exposed; reducing the count never silently deletes switches.
4. Choose **Power (On / Off)** or **Power-aware reboot** for each outlet. Its behavior explanation and recovery check delay appear only for power-aware reboot switches.
5. Optionally expand **Test connection and preview outlet states**. This reads current status using your unsaved settings; it sends no outlet power commands. Missing rows display **Unknown**.
6. Use Homebridge’s **Save** button, then restart Homebridge to apply the configuration.

Advanced connection settings are collapsed by default. All timing controls display **seconds**, including fractional seconds; existing JSON still uses millisecond fields with no configuration migration. New PDUs receive a permanent ID automatically. Existing IDs, Homebridge child-bridge metadata, and unrecognized settings are preserved.

Connection tests run only when requested, allow one active test per settings server, enforce a five-second cooldown and a maximum ten-second session deadline, and close their sockets afterwards. The settings server is separate from the running platform and may use one additional PDU session during a test; other clients still share the device session limit. Previewing never saves configuration or changes an outlet.

The screen adapts to narrow displays and uses Homebridge’s injected theme styles. Chromium tests exercise it with a simulated Homebridge UI bridge; validation in a running Homebridge installation is still pending.

For manual JSON configuration, add this entry to the Homebridge `platforms` array:

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

PDUs with either switch mode receive an initial status read even if recurring polling is disabled. Reads after cache expiry share a refresh. The polling interval applies to both modes; use 0 for on-demand status plus action recovery only. Long timeouts can exceed HomeKit's response deadline; start with defaults. Pending queue depth is bounded at 32, response buffers at 64 KiB.

### Outlet settings

| Setting | Meaning |
| --- | --- |
| `number` | Physical number, 1 through the PDU's `outletCount`. |
| `name` | Switch name in Home. |
| `mode` | `power` (normal On/Off) or `reboot` (power-aware reboot); one mode per configured outlet. |
| `resetAfterMs` | Legacy key for recovery check delay after an accepted/uncertain action; default 3000 ms, range 100-3600000 ms. Never changes physical reboot duration or forces displayed state. Ignored for power mode. |

Identity uses PDU ID, number, and mode. Renaming/reordering preserves identity; changing mode replaces the accessory and may require updating Home automations. Removing an outlet or PDU from valid configuration removes its accessories. Invalid configuration preserves cached accessories but makes their handlers unavailable.

## Commands and outages

- Complete login/operation/logout transactions are serialized per PDU. Other clients still share the assumed four-session device limit.
- User writes take precedence over pending polling; writes remain FIFO. Reads are coalesced across outlets.
- Writes invalidate the cache. Normal power commands request immediate shared verification; power-aware actions use delayed, bounded read-only recovery. A fresh confirmed no-op needs no extra verification. Requested HomeKit values and confirmed controller state are distinct.
- Missing rows and failed reads produce communication errors, not an invented Off state. Home may retain its last display until processing an update/error.
- Failures trigger a 5-second cooldown, doubling up to 5 minutes. Queued work fails rather than creating reconnect storms. Later reads/polls reconnect after cooldown.
- Writes are never automatically retried. A timeout/disconnect after transmission means **uncertain**: the PDU may have acted. Check before manually repeating a reboot.
- Power-aware reboot rejects duplicate/opposite writes while pending or recovering. The displayed state always follows confirmed status; an uncertain command is not replayed.
- Restart discovers actual state for both switch modes without replaying commands. Shutdown cancels recovery timers and queued work, and closes active connections.

## Verification

```bash
npm run lint
npm test
npm pack
node scripts/check-package.mjs
```

`lint` performs strict TypeScript checks including unused code. Tests use Node's test runner and local TCP servers, never physical PDUs. They cover optional login, wakeup/menu fallback, fragmented negotiation/prompts, configurable counts, parsing, queue/cache races, failures, deadlines, reboot timers/suppression, and accessory lifecycle with a simulated Homebridge API.

The package check extracts the archive into an isolated directory, checks core plugin loading/registration without installed dependencies, and verifies that all custom UI assets are included. The settings server dependency is installed automatically by npm. CI runs compiler checks, tests, and packaging on Node 22 and 24. Tests also cover the settings server through the real Homebridge UI IPC helper, configuration round-tripping, read-only previews, and Chromium interactions on desktop/mobile widths. Run `npx playwright install chromium` followed by `npm run test:ui` for browser checks. Simulated API/browser tests and package loading do not replace a complete live Homebridge/Home app test.

### Hardware validation still required

On the owned eight-outlet unit, use a selected noncritical load to verify status, On/Off, one native reboot triggered by an Off request, confirmed return to On, duplicate suppression, loss of the command/reply network path, and identity after restart. Verify the PDU restores power autonomously even when Homebridge cannot communicate during the cycle. Coordinate tests that could affect the SSH host or network. Avoid running the legacy integration against the same outlets during initial validation. Other models will be assessed when users provide feedback and sanitized output.

## Protocol reference

Based on [pponce/rpc3control](https://github.com/pponce/rpc3control/blob/master/rpc3Control.py), reviewed blob `62060ec220186c68c9b5665b0d75aa5efe9a12b4`: optional login, selection `1`, RPC prompt, `on/off/reboot N`, `MENU`, logout `6`. The third numeric field remains the physical outlet number; names with spaces are also accepted. A returned RPC prompt without a recognized error means acceptance, subject to hardware validation.

The GitHub reference has one RPC-3 path, not explicit per-model branches. Numeric RPC model suffixes are accepted under the same-UI assumption. The developer-local reference folder is inaccessible from the implementation environment; unpushed differences have not been compared.

[telnet-client](https://github.com/mkozjak/node-telnet-client/blob/master/src/index.ts) was evaluated. Its inspected login/negotiation paths make chunk-boundary assumptions, so this plugin uses a bounded incremental parser built on Node's standard library. It handles embedded/split IAC negotiation, echo, suppress-go-ahead, escaped IAC, and rejected unsupported options under [RFC 854](https://www.rfc-editor.org/rfc/rfc854). It does not emulate a general terminal or automatically answer confirmation/pagination prompts absent from the reference UI.

See [PLAN.md](PLAN.md) for agreed scope and implementation status.

