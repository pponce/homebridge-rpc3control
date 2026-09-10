# Requesting Homebridge verification

The program is called **Verified by Homebridge**. Approval is performed by the Homebridge project team; publishing a release does not grant verification automatically. No verification request has been submitted on your behalf.

## Submit the request

1. Sign in to GitHub as the plugin maintainer, `pponce`.
2. Open [Plugin Verification Request](https://github.com/homebridge/plugins/issues/new?template=1_verification-request.yml).
3. Enter `homebridge-rpc3control` as the npm plugin name.
4. Enter `https://github.com/pponce/homebridge-rpc3control` as the repository URL.
5. Attach [homebridge-rpc3control-icon.png](https://raw.githubusercontent.com/pponce/homebridge-rpc3control/main/assets/homebridge-rpc3control-icon.png) to the optional icon field. Download the PNG first, then drag it into the GitHub form. It is 100 × 100 pixels, matching the requested approximate dimensions.
6. Review and answer every requirement in the form based on your installation and the code. Add your tested PDU model and observed behavior in More Information. Submit the issue.

The initial verification form accepts an icon. The separate [Plugin Icon Request](https://github.com/homebridge/plugins/issues/new?template=2_icon-request.yml) is for already-verified plugins and must be submitted by their developer. Homebridge's icon registry controls the plugin search-card image; there is no package.json icon setting to add for this process.

## Requirements to review

The [current official requirements](https://github.com/homebridge/plugins/wiki/Verified-Plugins) include a dynamic platform, useful functionality beyond existing verified plugins, an npm publication and public GitHub repository with issues, release notes for each version, support for Node 22 and 24, settings GUI support, no unexpected startup activity before configuration, no special terminal/startup requirements, no system-modifying post-install scripts, no tracking, appropriate storage paths, and handled errors.

This project's existing implementation includes a dynamic platform, custom settings UI, and automated compiler, simulated-device, browser, and package checks. The release checks passed on Node 22 and 24. The platform rejects missing/invalid PDU configuration before starting PDU controllers. Status caching is in memory; accessory persistence is delegated to Homebridge. These observations help with the form but do not replace confirming actual installation and operation on your hardware.

The verified list did not show an entry containing BayTech or RPC3 when reviewed on 2026-09-10. Review the current list yourself before confirming the non-duplication requirement; general-purpose plugins may overlap in some functions.

## Suggested More Information

This plugin controls one or more BayTech RPC PDUs directly over Telnet, without Python, Pexpect, Script2, or an external Telnet executable. Each configured outlet can be a normal On/Off switch or a power-aware reboot switch. Native PDU reboot completes the power cycle independently after command acceptance, including when the reboot interrupts Homebridge's network path. The plugin includes per-PDU session serialization, shared status caching, optional polling, and a read-only connection preview in Homebridge UI.

Automated checks run on Node 22 and 24. One eight-outlet unit is available to the maintainer; other models are assumed to share the Telnet interface and four-session limit and remain unverified. Add the specific hardware and Homebridge tests you have personally completed before submitting.

## After approval

Follow the Homebridge team's review feedback. Once approved, Homebridge distributes the verification status and accepted icon to its UI; allow time for those updates to reach installations. Only then add a Verified by Homebridge badge to the README, using the badge examples in the [official plugin repository](https://github.com/homebridge/plugins#plugin-verification).

No npm version increment is needed just to attach an icon to the review issue. The icon and this guide are repository assets and do not change plugin runtime behavior.
