# ATS Companion

A React Native companion for American Truck Simulator, with a mobile dashboard and a Windows bridge.

## Current slice

- The mobile app has Drive, Job, Truck, and Bridge screens that adapt to narrow phones and wider tablets.
- The Windows bridge reads live ATS telemetry from the SCS telemetry plugin through a local named pipe and exposes a read-only snapshot API.
- Pair a phone by scanning the one-time QR code on the Windows setup page, or enter its short code. Device credentials are stored in the phone's secure storage.
- The mobile app retains the last snapshot and marks it stale when the bridge stops responding.
- Run the bridge with `--demo` to preview a clearly labeled sample dashboard.

## Run the mobile app

```powershell
cd mobile
npm install
npm start
```

## Run the Windows bridge

On the Windows PC, install dependencies and start the bridge:

```powershell
cd windows-bridge
npm install
npm start
```

The bridge requires Node.js 20 or newer.

The bridge opens its setup page on the PC. In the mobile app's Bridge tab, scan the displayed QR code or enter its bridge address and short code. The phone and PC must be on the same trusted Wi-Fi network. Allow Node.js through Windows Firewall for private networks if prompted.

To install the live telemetry plugin, install Visual Studio C++ Build Tools with the Desktop development with C++ workload, then run:

```powershell
npm run setup:plugin
```

The script downloads the official SCS Telemetry SDK, builds the x64 plugin, and copies it into the ATS plugin directory. Restart ATS and keep the bridge running. Use `npm start -- --demo` instead to preview sample readings without ATS.

The bridge defaults to port `3210`; set `PORT` to change it. Set `HOST` to `127.0.0.1` to restrict the server to the PC, or leave its default `0.0.0.0` to accept connections on network interfaces. Do not forward the bridge port to the internet.

Run bridge tests with:

```powershell
cd windows-bridge
npm test
```
