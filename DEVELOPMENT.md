# Development and releases

This document is for contributors and maintainers. User installation and configuration are in [README.md](README.md).

## Local development

Use Node 22.13+ within version 22, or Node 24. Clone `git@github.com:pponce/homebridge-rpc3control.git`, run `npm install`, then `npm test`. Installation builds the TypeScript sources through `prepare`.

For a development Homebridge installation, `npm link` must use the Node/npm installation and plugin prefix used by that Homebridge service. Configure and restart that installation through its UI. Do not assume a global link under another user's Node installation will be discovered.

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

## Publishing a stable release

The maintainer's npm account is **klidec** and the GitHub owner is **pponce**. GitHub Actions validates changes and creates package artifacts; publication is performed explicitly from the maintainer's terminal.

Keep `package.json` and `src/settings.ts` versions in sync. Use a plain version such as `0.1.0`, set `publishConfig.tag` to `latest`, update CHANGELOG.md, and add `releases/v<VERSION>.md` with the release notes. Commit and push the intended changes to `main`.

From a clean, synchronized `main` checkout, run `bash scripts/publish-release.sh`. It verifies the npm/GitHub accounts, remote commit, and available version/tag before creating a separate release directory from the committed tree. It installs development dependencies, runs compiler and behavior tests, validates the packed artifact, and publishes that archive publicly under `latest`. It then creates a non-prerelease GitHub release at the same source commit, attaches the npm archive, and marks the release as latest. It does not install or restart Homebridge.

Publication of a version is permanent. An already-published npm version or existing GitHub release makes the preflight stop. If npm publication succeeds but GitHub creation fails, use the exact GitHub recovery command printed by the script; do not publish the npm version again. The temporary release directory is retained, including the notes and checked archive needed by that command.

Browser checks run in CI and can also be run locally as described above. Physical hardware validation status is independent of selecting the stable release channel; other PDU models remain unverified until user feedback.

The older `scripts/publish-beta.sh` remains available for future prereleases. It intentionally rejects a stable version and requires beta publication defaults; prepare a separate prerelease version before using it again.
