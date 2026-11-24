---
title: 通过 T3 使用 Antigravity
description: 通过你的 T3 Code 服务在 Paseo 中使用 Antigravity。
nav: Antigravity（经由 T3）
order: 24
category: Providers
---

# 通过 T3 使用 Antigravity {#antigravity-via-t3}

在守护进程所在主机上运行 [T3 Code](https://github.com/pingdotgg/t3code) 服务，由它来运行 Antigravity。T3 用自己的集成启动和驱动 Antigravity；Paseo 和 T3 的网页端、手机端一样，只是连接 T3 的又一个客户端，自己从不启动 `agy`。

## 开始使用 {#getting-started}

1. 安装 `t3` 命令行，并以运行 Paseo 守护进程的同一用户启动它的服务（`t3 service install` 可让它常驻）。
2. 在 T3 中登录 Antigravity。你在 T3 里添加的每个 Antigravity 账号都会出现在 Paseo 中。
3. 在 Paseo 中选择 **Antigravity (via T3)**。

首次使用时，Paseo 会运行 `t3 pair --label Paseo`，用一次性令牌换取一个只能读取和发送对话的会话。T3 会在已连接客户端中把它列为 **Paseo**；在那里撤销即可断开。会话保存在 `~/.paseo/t3-provider/credentials.json`，只有你的用户可读。会话过期或被 T3 撤销后，Paseo 会重新配对。

如果 T3 服务在另一台机器上，在那台机器上运行 `t3 pair --label Paseo`，把它打印的配对 URL 交给 Paseo：

```json
{
  "agents": {
    "providers": {
      "antigravity-t3": {
        "env": { "T3_PAIRING_URL": "https://my-server:3773/pair#token=…" }
      }
    }
  }
}
```

## 能用到什么 {#what-you-get}

每个 Paseo 对话对应一个 T3 对话，属于以对话工作目录为根的 T3 项目。模型按 T3 账号列出（`模型 · 账号`），选模型即选账号。Paseo 不会自行切换账号。

助手回复、思考过程、命令、文件改动、搜索、待办、子 agent、上下文压缩、权限确认、提问和密钥请求都会显示在 Paseo 中。每轮的 token（输入、缓存命中、输出）和上下文用量来自 T3，账号额度也是。检查点、分叉、交接、设备预览等对话之外的 T3 功能留在 T3 里使用，同一个对话在那边也是打开的。

## 关闭直接调用 `agy` {#turn-off-direct-agy-use}

直接调用的 [Antigravity](/docs/supported-providers/antigravity) provider 在你添加之前处于关闭状态：**设置 → Providers → 添加 Provider → Antigravity**。关闭时，Paseo 不会为对话或用量显示启动 `agy`。要再次关闭，在 **设置 → Providers** 中打开 **Antigravity** 并移除它。
