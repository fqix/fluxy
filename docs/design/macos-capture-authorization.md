# macOS Helper 与 CA 合并安装

2026-09-08。已实现合并执行路径；真实首次授权次数待目标 macOS 验收。

保留现有 Helper、未签名 Electron 开发方式、sing-box 与 Split DNS，不迁移原生扩展，不修改系统授权规则。

## 历史依据与修正

kube-loop 的 `41987a21` 最早将 Helper 安装与 `security add-trusted-cert` 拼入同一提权脚本；`fd5929fe` 因嵌套授权问题拆开了它们。后续 `79d2fa6b` 改为由同一提权流程中的 worker 执行 `trust-certificate`，通过 cgo 直接调用 Security.framework。

Fluxy 现在移植后一种执行结构。此前把普通用户进程的独立信任路径推导为“任何保留 Helper 的方案都不可合并”，结论过强；历史实现值得在目标机器验证。但历史注释、mock 测试和一次 CLI 调用均不能证明当前系统只会显示一次授权。

## 执行顺序

1. 主进程检查现有 CA 的实际信任状态和 Helper 状态，复用有效 CA。
2. 原生桌面适配器申请安装授权，启动现有 elevated installer。
3. 安装脚本校验并安装 Helper/core/配对文件；安装失败则不触碰 CA。
4. 安装成功后，执行已安装且已校验的固定 Helper 路径，子命令为 `trust-ca-privileged`，stdin 仅包含 JSON 编码的公钥证书 DER/base64。
5. CLI 校验证书、有效期与 root 身份；插入 System.keychain，在同一提权进程内设置并检查 admin trust。
6. 安装适配器返回真实结果，不再回到普通用户进程调用 `desktopTrustCertificate`。任何失败保留具体错误，不自动换用另一个授权入口重试。
7. Electron 原有设置流程继续校验实际信任结果，不能只检查公钥是否已导入。

## 安全与重试

- 新命令只存在于 CLI，不加入常驻 Helper RPC 方法集合。
- rootless 测试 Helper 禁止 CA 修改，普通用户 CLI 调用被拒绝。
- 不传私钥，不接受任意证书文件路径，不修改 SIP、authorizationdb 或用户凭据。
- 已安装 Helper 的证书单独重试保留原有流程；已信任 CA 的 Helper 更新不携带证书，避免重复信任写入。
- 安装过程中 CA 失败保留已安装 Helper；重试前重新检查实际状态。

## 验收

自动检查：Helper-only 不调用证书步骤；安装失败不调用证书步骤；公钥传输完整；非 root 被拒绝；Go race/vet；主进程 Helper 和 UI 回归；构建完整性校验。

真实 macOS 首次验收：Helper 缺失、专用 CA 未信任，执行完整设置并记录系统授权次数。必须同时证明 Helper ready、证书实际 trusted、总共一次授权。已信任的旧 CA 不能用于证明首次路径。不要为验收擅自撤销用户正在使用的 CA 或停止其 TUN。

来源：`/Users/fengqi/github/kube-loop` 的上述历史提交。移植为相同职责的最小实现，未复制整个旧 Helper 或替换当前运行服务。
