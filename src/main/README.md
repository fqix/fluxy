# Main process

`index.ts` is the Electron entry point. It loads `app/bootstrap.ts`, which wires services, IPC handlers, windows, and application lifecycle together.

| Directory       | Responsibility                                                                            |
| --------------- | ----------------------------------------------------------------------------------------- |
| `app/`          | Application startup, shutdown coordination, and native menus                              |
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
