# vless-voroa-in — Voroa 部署准备（未部署，等用户决定）

准备时间：2026-11-07 晚（第四轮调研后，Omeganodes 出局后）

## 状态

- **未注册、未部署。** 只准备好了代码，等用户说“试 Voroa”再动手。
- 命名：`vless-voroa-in`（孟买→印度；部署后按客户端显示的旗帜再校正，与既有命名规则一致）。

## Voroa 条款核查结果（2026-11-07 23:53–23:57 UTC 实查）

- **没找到任何公开的 Terms / AUP。** 官网首页（getvoroa.com，当晚抓取）全文无法律页脚链接；文档索引（getvoroa.com/docs/，635 行）全文无 "Terms" 字样；“Platform Protections” 章节只有安全功能（DDoS、HTTPS、2FA、备份），无可接受使用 / 代理条款。
- 这与 Omeganodes 不同：Omeganodes 是条款第 4 条**明确禁止**代理（已出局）；Voroa 是**根本没公布条款**——没有明文禁令，也没有明文许可。
- 结论：条款风险是“未知”，不是“已禁”。只能用一次探针部署验证实际容忍度，部署后若被暂停即放弃，损失只是一次免费注册。
- 登录方式已确认：邮箱一次性验证码、Google、GitHub 三种（安全总览页原话），邮箱验证码符合用户偏好。
- 仍未验证：注册是否需要手机号验证（印度平台常见要求），只能在注册时当场确认。

## 免费层关键数字（官网当晚实查，与第四轮报告一致）

- Free ₹0/月，免卡；Nano 0.1 vCPU / 512 MB；**750 运行小时/月**（单服务全月约 744 小时，刚好够）；**5 GB 带宽/月**（超了整个 workspace 的免费服务停到下月 1 日）；500 构建分钟/月；15 个服务上限。
- **不要同时跑免费数据库**：免费数据库也占 750 小时。
- 区域孟买（另提 Bangalore）；对美东延迟约 200ms+，可用但不算快。
- 平台极新（2026 年 9 月才开始宣传），官方明说免费条款可随时改。

## 代码改动（相对 vless-wasmer-us，已完成并通过 node --check）

- `server.js`：零依赖 Node 代码原样复用，只加了 **30 秒 WS ping**（服务端每 30 秒发 ping 帧，客户端自动回 pong），因为 Voroa 边缘约 100 秒无数据即关闭 WS 连接。ping 定时器在会话结束时清除。
- `Dockerfile`：`node:22-alpine`，Dockerfile 部署——按官方《Idle sleep》文档，Dockerfile 构建的服务**永不休眠**，这是免费层常驻的关键。
- 环境变量与之前一致：`VLESS_UUID` / `WS_PATH` / `PORT`（平台注入）。

## 预留凭证（仅写在这里和部署时用，不要进公开仓库）

- `VLESS_UUID`: `ed582c84-6e3e-4800-865a-fb14c4b0e0df`
- `WS_PATH`: `/72465f67b6811e52`
- 与 Choreo 预留的那组不同（Choreo 已放弃，那组不用）。

## 部署步骤（用户批准后）

1. Voroa 注册：邮箱 `liangshuangwork@gmail.com` + 验证码（首选）；若要求手机号，当场停下问用户。
2. 新建 GitHub 仓库（如 `vless-voroa-in`），推 `server.js` + `Dockerfile` + `package.json`（**不含**本 README 里的凭证）。
3. Voroa 建 Web Service → 连仓库 → 选 Docker runtime → 设环境变量 `VLESS_UUID` / `WS_PATH` → 部署。
4. 拨测：经节点取 example.com 真实 200；空闲 15 分钟以上后再拨一次，验证 Dockerfile 路线确实不休眠。
5. 通过后按客户端旗帜校正命名，加入面板与统一订阅（5→6 节点）；不通过则放弃，仓库保留备查。

## 文件

- `server.js` — VLESS over WS 服务（含 30 秒 ping）
- `Dockerfile` — node:22-alpine
- `package.json` — 零依赖
