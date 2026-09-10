# Fluxy

Fluxy 是使用 **Electron、TypeScript 和 React** 构建的网络调试桌面应用。

[English](README.md) · [使用与开发说明](ELECTRON.md) · [自动更新发布](ELECTRON_RELEASE.md)

## 一键安装发布版

在对应平台的终端执行以下命令，下载并安装最新发布版。

发布矩阵覆盖 **macOS ARM64、Linux x64/ARM64、Windows x64/ARM64**，Linux 提供 deb 和 rpm 安装包，暂未配置 ARM32。

### macOS / Linux

```sh
curl --fail --location https://raw.githubusercontent.com/fqix/fluxy/main/install.sh | bash
```

macOS 安装到 `~/Applications/Fluxy.app`。Linux 根据包管理器选择 **deb 或 rpm**，安装时请求 sudo 权限。

未配置 Apple 凭据时，macOS 发布包采用临时签名、不做公证。首次打开如被系统阻止，请在 **系统设置 → 隐私与安全 → 仍要打开** 中手动放行。

### Windows（PowerShell）

```powershell
irm https://raw.githubusercontent.com/fqix/fluxy/main/install.ps1 | iex
```

使用当前桌面用户打开 PowerShell 执行，脚本会下载并静默安装到当前用户。

脚本自动识别架构并校验 SHA-256；需先发布对应平台的安装包和校验文件。使用 `--dry-run` 预览解析出的下载地址，`--version` 指定版本。脚本源码：[macOS / Linux](install.sh) · [Windows](install.ps1)。

## 开发运行

```sh
git submodule update --init --recursive
npm ci
npm run dev
```

需要 Node.js 22.12+ 和 npm。各平台构建均需 Go，macOS 另需 Xcode Command Line Tools，用于编译传输核心及 Electron 专用权限助手；不依赖 Rockxy 应用、Xcode 工程或原版 SwiftPM 依赖。打包后的应用已包含所需运行组件。

## 主要功能

- HTTP/HTTPS 抓包、WebSocket 检查、系统代理和 macOS / Windows 按域名 TUN 捕获。
- 应用来源识别、高级筛选、项目、会话及 HAR 导入导出。
- 请求/响应断点、映射及请求头规则、网络预设和双向限速。
- 请求/响应/耗时及文本 Diff、历史、置顶和导出。
- 证书管理、请求编辑重发、脚本、Protobuf/gRPC 和 MCP。
- 自动检查更新、下载和校验，点击后重启安装；正式更新需要发布签名包。

AI 助手已移除。实现范围及边界见[功能补全记录](ELECTRON.md)。

### TUN 兼容性说明

启动 TUN 前必须填写至少一个合法的捕获域名，每行一个，包含其子域名。空列表或任意非法域名都会阻止手动启动和自动恢复；不接受 URL、IP 地址、端口或路径。域名会统一为小写、去重，并规范化开头的 `*.` 和末尾的点。

按域名 TUN 捕获支持 macOS 和 Windows 10/11。使用自动出口设置并清空显式路由 CIDR 后，Fluxy 可通过自己的 Split DNS / Fake IP 与 Mihomo、sing-box 共存，仅捕获所选域名；停止时移除临时 DNS 配置。Windows 通过 NRPT 规则分流选定域名，首次使用或更新权限助手时需要 UAC 授权；已有 DNS 策略与捕获域名重叠时会拒绝启动。Linux 请使用 HTTP Proxy 模式。

## 验证与打包

```sh
npm run typecheck
npm run format:check
npm test
npm run test:e2e
npm run package
npm run dist
```

测试使用临时目录和本地服务器。实际系统代理、证书信任、权限助手安装及 TUN 路由由应用中的明确操作触发。macOS、Linux、Windows 已有 Helper、TUN、证书信任和打包实现；Linux/Windows 的提权安装与实际路由仍需原生桌面验收。详见 [平台要求](helper/README.md)。

## 项目结构

- `src/main`：Electron 主进程、代理、持久化及系统集成。
- `src/preload`：界面通信接口。
- `src/renderer`：React 桌面界面。
- `src/shared`：数据模型及共享逻辑。
- `helper`：macOS、Linux、Windows 共用的 Go 权限助手。
- `third_party/patches/sing-box`、`third_party/sing-box`：固定版本的传输核心及构建工具。
- `tests`：单元、集成和桌面测试。
- `resources`：图标和依赖声明。

## 许可证与来源

Fluxy 原创贡献采用 [MIT 许可证](LICENSE)。第三方依赖和源自 Rockxy 的材料仍适用各自原许可证，不因本次修改而重新授权。详见[版权与适用范围](COPYRIGHT.md)和[第三方声明](THIRD_PARTY_NOTICES.md)。

## sing-box 代理内核

正式抓包使用 sing-box 子进程，内置基于 goproxy 的检查服务，支持 HTTP/HTTPS、HTTP/2、gRPC/gRPCS、SSE、WS/WSS；规则、脚本和断点仍由 Fluxy 主进程执行。源码补丁、依赖版本和构建说明见 [third_party/patches/sing-box](third_party/patches/sing-box/README.md)。应用内置代理二进制，无需单独安装 Go 或 Node.js。

`npm run test:protocol` 运行本地协议回归，覆盖 SSE 实时事件及取消、双向 WebSocket 文本/二进制帧，以及 gRPC/gRPCS 的 Unary、客户端流、服务端流、双向流、错误状态、trailers 和取消传播。`npm run test:protocol:public` 使用 go-httpbin（httpbingo.org）和 grpcbin（grpcb.in），逐项对比直连与代理结果。响应详情提供 Trailers 页签。
