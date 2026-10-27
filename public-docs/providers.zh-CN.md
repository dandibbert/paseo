---
title: Provider
description: Paseo 如何看待编程 Agent：封装现有 CLI、原生支持与 ACP 支持，以及接下来去哪里。
nav: Provider
---

# Provider {#providers}

Paseo 在带有编辑器、终端、diff（桌面端还有浏览器）的工作区中运行**你已安装并完成认证的现有编程 Agent**。你可以并行运行多个 Agent，为每个任务选择 Provider，并在同一个应用中审查它们的工作。你的订阅、配置、技能和 MCP 服务器都保持不变。

想体验这套工作流，可以[在不同的 worktree 中运行并行任务](/docs/parallel-development)。

## 心智模型 {#mental-model}

Provider 是 Paseo 与某个外部 Agent CLI 之间的约定：如何启动它、如何流式读取输出、如何回传输入、支持哪些模式。实际的二进制文件位于你的机器上，作为普通子进程运行。

## 两个层级 {#two-tiers}

- **原生支持**：Paseo 为主流 Agent（Claude Code、Codex、OpenCode、Pi、[Antigravity](/docs/supported-providers#antigravity)、[Muse Code](/docs/muse-code)）内置了适配器。安装底层 CLI 后会被自动发现，并在适用时提供模式元数据和语音支持。
- **ACP 目录**：任何使用 [Agent Client Protocol](https://agentclientprotocol.com) 的 Agent 都可以通过通用适配器获得支持。Paseo 提供一个精选目录，支持一键安装（Cursor、Gemini、GitHub Copilot、Hermes、Kimi、Qwen Code 等 25 个以上），你也可以自行添加任何其他 ACP Agent。

无论哪种方式，**底层 CLI 都由你安装**，Paseo 负责运行它。

## 更新 CLI {#update-a-cli}

打开**设置 → 你的主机 → Provider → 对应 Provider → CLI 更新**，检查是否有新版本。确认前请核对主机、可执行文件路径和升级命令。即使你使用手机或另一台电脑操作，升级也在对应 daemon 主机上执行。

在 macOS 和 Linux 上，Paseo 根据 Provider 实际使用的可执行文件识别安装方式，包括自定义命令和环境变量覆盖：

- Claude Code、OpenCode、Cursor、OMP 和 Goose 的官方原生升级命令。
- Muse 已安装的启动器，使用 Meta 提供的同步安装模式。
- npm、pnpm 和 Bun 全局安装的包，包括 ACP 和插件 Provider。包名来自可执行文件所属的已安装包，不受 Provider 白名单限制。
- Homebrew formula 和 cask，通过解析后的 Cellar 或 Caskroom 安装路径验证。
- ACP 目录中固定版本的 `npx` 命令。Paseo 先准备新版本包，再保存主机上的新启动命令，不会另装一份全局 CLI。
- 自定义安装器通过 `updateCommand` 指定的命令。见[自定义 Provider](/docs/custom-providers#cli-update-commands)。

原生升级器和包管理器按自身通道设置选择目标版本。目标版本未知时，Paseo 显示将执行的命令，不会声称已知版本。CLI 已是最新版时，命令成功退出且未做修改也属于正常结果。升级后会重新检查选中的安装。npm 和固定版本的 `npx` 升级会解析并显示具体目标版本。

Antigravity 官方安装器提供后台自动升级，没有文档化的独立升级命令，Paseo 不会自行编造；通过包管理器安装或显式配置升级命令的版本仍可使用。无法识别的安装布局、系统软件包、Windows 和容器需要使用原安装工具。Paseo 不使用 `sudo`，也不执行下载的安装脚本。每次升级都需要确认。

请等待所有正在运行的任务结束，包括配置别名和子 Agent。自定义 ACP 条目可能使用同一可执行文件，却没有共同的 Provider ID，因此 Paseo 会在升级和验证完成前阻止所有新的 Agent 工作。已有会话保留原进程；要使用新版 CLI，请启动新会话。daemon 不会重启。如果连接中断，主机可能仍在升级，请先检查已安装版本再重试。

更新 Paseo 本身不会更新 Provider CLI。Paseo 的版本更新见[更新](/docs/updates)。

## 接下来 {#where-to-go-next}

- [支持的 Provider](/docs/supported-providers)：完整列表和安装链接。
- [Agent 配置](/docs/agent-profiles)：把模型、模式和思考设置保存在一起，并附上指导委派的说明。
- [自定义 Provider](/docs/custom-providers)：添加你自己的 Provider、把现有 Provider 指向其他端点、配置多个 Provider 别名，或在 `~/.paseo/config.json` 中覆盖二进制文件。
- [paseo.sh/agents](/agents)：每个支持的 Provider 的落地页。
