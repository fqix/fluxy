# Fluxy

Fluxy 是使用 **Electron、TypeScript 和 React** 构建的网络调试桌面应用。

[English](README.md) · [使用与开发说明](ELECTRON.md) · [自动更新发布](ELECTRON_RELEASE.md)

## 一键安装发布版

在对应平台的终端执行以下命令，下载并安装最新发布版。

### macOS / Linux

```sh
curl --fail --location https://raw.githubusercontent.com/fqix/fluxy/main/install.sh | bash
```

macOS 安装到 `~/Applications/Fluxy.app`。Linux 根据包管理器选择 **deb 或 rpm**，安装时请求 sudo 权限，不使用 AppImage。

### Windows（PowerShell）

```powershell
irm https://raw.githubusercontent.com/fqix/fluxy/main/install.ps1 | iex
```

使用当前桌面用户打开 PowerShell 执行，脚本会下载并静默安装到当前用户。

脚本自动识别架构并校验 SHA-256；需先发布对应平台的安装包和校验文件。指定版本或预览安装操作（dry-run）详见[安装说明](tools/install/README.md)。脚本源码：[macOS / Linux](install.sh) · [Windows](install.ps1)。

## 开发运行

```sh
git submodule update --init third_party/sing-box
npm ci
npm run dev
```

需要 Node.js 22.12+ 和 npm。各平台构建均需 Python 3.10+ 和 Go，macOS 另需 Xcode Command Line Tools，用于编译传输核心及 Electron 专用权限助手；不依赖 Rockxy 应用、Xcode 工程或原版 SwiftPM 依赖。打包后的应用已包含所需运行组件。

## 主要功能

- HTTP/HTTPS 抓包、WebSocket 检查、系统代理和 macOS、Linux、Windows TUN。
- 应用来源识别、高级筛选、项目、会话及 HAR 导入导出。
- 请求/响应断点、映射及请求头规则、网络预设和双向限速。
- 请求/响应/耗时及文本 Diff、历史、置顶和导出。
- 证书管理、请求编辑重发、脚本、Protobuf/gRPC 和 MCP。
- 自动检查更新、下载和校验，点击后重启安装；正式更新需要发布签名包。

AI 助手已移除。实现范围及边界见[功能补全记录](ELECTRON.md)。

### TUN 兼容性说明

当前 Fluxy 的 TUN 模式会与 Clash、sing-box 冲突。启用 Fluxy TUN 前，请先关闭这些应用的 TUN 模式或退出应用，避免同时启用多个 TUN 模式。

## 验证与打包

```sh
npm run typecheck
npm run format:check
npm test
npm run test:e2e
npm run package
npm run dist
```

测试使用临时目录和本地服务器。实际系统代理、证书信任、权限助手安装及 TUN 路由由应用中的明确操作触发。macOS、Linux、Windows 已有 Helper、TUN、证书信任和打包实现；Linux/Windows 的提权安装与实际路由仍需原生桌面验收。详见 [平台要求](tools/helper/README.md)。

## 项目结构

- `src/main`：Electron 主进程、代理、持久化及系统集成。
- `src/preload`：界面通信接口。
- `src/renderer`：React 桌面界面。
- `src/shared`：数据模型及共享逻辑。
- `tools/helper`：macOS、Linux、Windows 共用的 Go 权限助手。
- `tools/sing-box`、`third_party/sing-box`：固定版本的传输核心及构建工具。
- `tests`：单元、集成和桌面测试。
- `resources`：图标和依赖声明。

## 许可证与来源

Fluxy 原创贡献采用 [MIT 许可证](LICENSE)。第三方依赖和源自 Rockxy 的材料仍适用各自原许可证，不因本次修改而重新授权。详见[版权与适用范围](COPYRIGHT.md)和[第三方声明](THIRD_PARTY_NOTICES.md)。
