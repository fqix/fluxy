# Shared modules

These modules are used by the main process, preload bridge, renderer, and tests.

| Directory    | Responsibility                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `app/`       | Menu commands, setup instructions, and update state                                              |
| `contracts/` | Application settings, traffic models, validation schemas, and the preload IPC API                |
| `traffic/`   | HAR/OpenAPI conversion, protocol presentation, filtering, timing, redaction, and network presets |
| `rules/`     | Breakpoint message parsing and formatting                                                        |
| `workspace/` | Project/workspace schemas and transaction diff contracts                                         |

Import the required file directly, for example `@shared/traffic/filters` or `@shared/contracts/model` in the renderer. Keep Electron services, filesystem persistence, and UI components in their owning process directories. The central `contracts/model.ts` retains the application-wide IPC contract so preload and both processes use the same types and schemas.
