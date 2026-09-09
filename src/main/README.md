# Main process

`index.ts` is the Electron entry point. It loads `app/bootstrap.ts`, which wires services, IPC handlers, windows, and application lifecycle together.

| Directory       | Responsibility                                                                            |
| --------------- | ----------------------------------------------------------------------------------------- |
| `app/`          | Application startup, shutdown coordination, native menus, and About information           |
| `capture/`      | HTTP/HTTPS capture, upstream forwarding, process identity, timing, and network conditions |
| `certificates/` | Root certificates and imported client/server certificates                                 |
| `diff/`         | Transaction comparison and saved diff workspaces                                          |
| `integrations/` | MCP server/stdio bridge and GitHub Gist sharing                                           |
| `protocols/`    | Protobuf compilation and decoding                                                         |
| `rules/`        | Breakpoint matching and script execution                                                  |
| `storage/`      | Settings, sessions, projects, and private file writes                                     |
| `system/`       | OS proxy configuration, crash recovery, and privileged helper integration                 |
| `tun/`          | TUN configuration, platform routing, and tunnel bridge                                    |
| `updates/`      | Application update lifecycle                                                              |

Import services directly from their owning module. Shared contracts and portable data transformations live in `../shared`; renderer components must not import main-process services.

The build keeps `out/main/index.js`, `out/main/watchdog.js`, and `out/main/mcp-bridge.js` as stable entry names. Paths relative to `__dirname` refer to that bundled output directory, not to these source directories.

In HTTP Proxy mode, `capture/sing-box-proxy.ts` starts the bundled sing-box core on the configured public port. Its `fluxy-mixed` inbound delegates SOCKS to sing-box and carries HTTP unchanged to a private, ephemeral loopback listener in `fluxy-proxy`. The authenticated internal CONNECT envelope preserves the original client endpoint for process attribution. TLS interception, rules and streaming remain in the inspection engine. HTTP/HTTPS system proxy settings and manual SOCKS5 clients share the public port. UDP is rejected in this mode. TUN mode retains its existing bridge and egress path. Capture startup waits for both processes before changing system settings; normal stop, startup failure, process failure and parent-pipe EOF close the owned listeners.

Capture settings are persisted in `preferences.json`. `maxEntries` defaults to 10,000 (100–10,000); reducing it evicts the oldest live records while preserving paused breakpoints. `maxRequestBodyBytes` and `maxResponseBodyBytes` independently limit retained body bytes to 0–2 MiB each (default 2 MiB, 0 keeps headers only). Settings displays body limits in KiB. The limits cover HTTP capture, Compose, and each direction of a WebSocket connection; oversized previews are marked truncated while traffic is forwarded in full. Saved favorites and sessions keep their existing JSON format.
