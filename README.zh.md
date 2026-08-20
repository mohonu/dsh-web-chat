# dsh-webchat

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供的「Codex ChatGPT 模式」插件：通过真实浏览器驱动 [chat.deepseek.com](https://chat.deepseek.com)，用你的 DeepSeek 网页登录会话与 `deepseek-chat`（及 `deepseek-reasoner`）对话，**无需 API 额度**。对话可随时「转移到 Harness」——蒸馏成可执行任务简报并新建一个 harness 会话作为开发上下文，也可把网页对话导入为 markdown 上下文，或让 harness agent 直接通过同一个网页会话继续提问。

## 特性

- **网页聊天**：复用 DeepSeek 网页端登录，流式获取回复，支持「深度思考（R1）」与「智能搜索」开关。
- **转移到 Harness**：一键把当前网页对话蒸馏成任务简报（首条消息即简报）并创建新 harness 会话，继续开发。
- **导入为上下文**：把存储的网页对话导出为 markdown 上下文。
- **Agent 工具**：`webchat_status` / `webchat_send` / `webchat_import` / `webchat_transfer`，harness agent 可直接调用。
- **无感登录**：首次使用弹出可见浏览器窗口完成登录，登录后窗口自动关闭，后续聊天在无头浏览器中进行。

## 安装

### 从 npm（发布后）

```bash
dsh plugin --profile web add dsh-webchat
```

### 从 GitHub

```bash
dsh plugin --profile web add github:xmuwenxiang/dsh-web-chat
```

> 仓库已提交编译产物 `lib/`，从 git 安装无需额外构建。

## 首次使用

1. 打开 Web GUI 侧边栏「网页聊天」入口。
2. 点击「打开登录窗口」，在弹出的浏览器中完成 DeepSeek 网页登录。
3. 登录成功后窗口会自动关闭，之后即可正常聊天 / 转移。

## 配置

插件设置中可调整：`browserChannel`（浏览器渠道，默认 auto）、`browserExecutablePath`（显式浏览器路径）、`browserProxy`（代理）、`browserHeadless`（聊天是否无头，默认 true——登录窗口始终可见且登录后自动关闭）、`replyTimeoutMs`（回复等待上限）、`transferDistill` / `transferProvider` / `transferModel`（转移时的蒸馏模型）。

## 环境要求

- Node.js >= 22
- 已安装 Google Chrome 或 Microsoft Edge
- 首次登录需要可交互的图形环境（弹出登录窗口）

## 限制

- 网页端受 DeepSeek 官方风控；页面改版或操作失败时返回错误而非崩溃。
- 密码/会话凭据保存在本地私有目录（profile），请勿外泄。

## License

[Apache-2.0](./LICENSE)
