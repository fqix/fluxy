// Package platform adapts the helper to launchd, systemd and the Windows
// service manager: the administrator-owned installation directory, the local
// listener, caller verification and child-process containment.
//
// Env is deliberately minimal: the core must never inherit a user-controlled
// dynamic loader, proxy or sing-box setting.
package platform
