# deploy/neko-fp/

Fingerprint variant of `deploy/neko/`: same Neko container layout, but the controlled browser is
[fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium) instead of Google Chrome.
Enabled by `--fingerprint-seed <n>` (or `ARISE_BROWSER_FINGERPRINT_SEED`).

## Why

Chrome in the stock image renders canvas on the CPU, so every server built from the same image has the
same canvas hash, fonts, screen and timezone — deleting and recreating a VM gives an identical
fingerprint. fingerprint-chromium derives a stable, distinct fingerprint from a seed.

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | `ghcr.io/m1k1o/neko/google-chrome:3.2.0` + fingerprint-chromium (downloaded with `ADD --checksum`) |
| `launch-browser.sh` | Builds the browser command line from `ARISE_FP_*` env; installed as `/usr/local/bin/arise-fp-browser` |
| `supervisord.conf` | Same programs as `deploy/neko/`, Chrome program runs the launcher |
| `policies.json` | `deploy/neko/` policies + deny geolocation, WebRTC `disable_non_proxied_udp`, no flag warning bar |

## Runtime inputs (container env, set by arise-browser)

| Variable | Default | Notes |
|----------|---------|-------|
| `ARISE_FP_SEED` | required | 1–2147483647. Not baked into the image: one image serves every identity |
| `ARISE_FP_TIMEZONE` | `UTC` | Should match the egress IP's location |
| `ARISE_FP_LANG` | `en-US` | `--lang`; `--accept-lang` becomes `<lang>,<base>` |

## Consistency choices

Spoof only what can't be cross-checked; keep the rest real.

| Signal | Value | Why |
|--------|-------|-----|
| Platform | `linux`, kernel version as `6.12.117` | Fonts and TCP/IP stack are Linux; claiming Windows contradicts both |
| Cores | real `nproc` | Sites can estimate cores with Web Workers |
| Brand / version | `Chrome` / engine version | UA, UA-CH and engine agree |
| Canvas, audio, ClientRects, WebGL image | from seed | Real values are shared by every server on this image |
| QUIC, non-proxied WebRTC UDP | off | Nothing bypasses a proxy once one is configured |

Measured gaps (2026-11-17, fingerprint-chromium `150.0.7871.186`):

- WebGL renderer shows SwiftShader: fingerprint-chromium only fakes the GPU when the platform is Windows.
- `deviceMemory` comes from the seed (no flag to override).
- fingerprint-chromium lags Chrome stable by a few major versions.

## Profile

The volume is `<container>-profile` (default `arise-neko-fp-profile`), separate from the stock image's:
fingerprint-chromium is older than the image's Google Chrome and refuses a profile written by a newer
version. An identity = seed + this volume.

## Updating fingerprint-chromium

Bump `FP_VERSION` and the `--checksum` in `Dockerfile` (digest of the `*_linux.tar.xz` release asset,
`gh api repos/adryfish/fingerprint-chromium/releases` → `.assets[].digest`). It is a third-party binary
whose source is published one release later; the checksum only proves the file matches the release.
