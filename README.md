# Network Traffic & Bandwidth Pulse

A small GNOME Shell extension for Zorin OS that shows live network traffic in
the top panel. It samples `/proc/net/dev`, draws a Cairo sparkline, and opens a
menu with the busiest processes when `nethogs` is installed.

## Install locally

```bash
sudo apt install nethogs
mkdir -p ~/.local/share/gnome-shell/extensions/network-pulse@sudipto
cp metadata.json extension.js stylesheet.css \
  ~/.local/share/gnome-shell/extensions/network-pulse@sudipto/
gnome-extensions enable network-pulse@sudipto
```

On Xorg, press `Alt+F2`, enter `r`, and press Enter to reload GNOME Shell.
On Wayland, log out and back in.

## Notes

`/proc/net/dev` provides reliable system-wide byte counters. Linux does not
expose simple per-process network byte counters through procfs, so the process
list is obtained from `nethogs` when available. If it cannot be launched, the
dropdown keeps showing the system-wide rates and explains how to enable the
optional process view.

Depending on the distribution configuration, `nethogs` may also need network
capture privileges. The extension deliberately does not invoke `sudo` or
`pkexec`; grant the required capability to `nethogs` yourself only if you
understand the security implications.

## Publish on GNOME Extensions

1. Create a public GitHub repository named `network-pulse` under the
   `Sudipto-git` account, or update the `url` in `metadata.json` to your
   actual repository URL.
2. Push `metadata.json`, `extension.js`, `stylesheet.css`, `LICENSE`, and this
   README to that repository.
3. Build the extension bundle from this directory:

   ```bash
   rm -rf /tmp/network-pulse-pack
   mkdir -p /tmp/network-pulse-pack
   gnome-extensions pack . --out-dir=/tmp/network-pulse-pack --force
   ```

4. Sign in at [extensions.gnome.org](https://extensions.gnome.org/), open
   **Submit an extension**, and upload the generated
   `network-pulse@sudipto.shell-extension.zip`.
5. Select the supported GNOME Shell versions, add screenshots and a clear
   description, then submit it for review.

The extension UUID is `network-pulse@sudipto`; changing it after publication
would create a separate extension listing. GNOME’s review process may request
changes before the listing becomes public.
