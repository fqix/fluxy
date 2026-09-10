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

`capture/inspector-transport.ts` starts one bundled sing-box process with a `fluxy-mixed` public inbound and an embedded `fluxy-inspector` service. `fluxy-inspect` hands connections to the service in memory, preserving the original client endpoint without a private TCP inspection port. TLS interception and streaming run in sing-box; Electron handles rules, scripts and breakpoints over framed stdin/stdout IPC. Logs use stderr. HTTP/HTTPS system proxy settings and manual SOCKS5 clients share the public port; UDP is rejected. TUN mode instead attaches to the single Helper-owned sing-box, which includes the TUN inbound and the same embedded inspector. An authenticated one-use loopback relay forwards IPC to its inherited pipes; no second sing-box or HTTP inspection bridge is started. Capture startup waits for both inspector readiness and core listener startup before changing system settings. Normal stop, startup failure, process failure and parent-pipe EOF close the owned listener.

Capture settings are persisted in `preferences.json`. `maxEntries` defaults to 10,000 (100–10,000); reducing it evicts the oldest live records while preserving paused breakpoints. `maxRequestBodyBytes` and `maxResponseBodyBytes` independently limit retained body bytes to 0–2 MiB each (default 2 MiB, 0 keeps headers only). Settings displays body limits in KiB. The limits cover HTTP capture, Compose, and each direction of a WebSocket connection; oversized previews are marked truncated while traffic is forwarded in full. Saved favorites and sessions keep their existing JSON format.
