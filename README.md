# AI Git Commit

用云端 Chat Completions 模型为 Git 变更生成提交信息，并填写到 VS Code 原生 SCM 输入框。有暂存变更时只分析暂存区；暂存区为空时分析工作区的未暂存修改和未跟踪文件。支持多仓库、中文 Conventional Commits、大型差异分块、取消生成。扩展不会执行 `git add`、`git commit` 或 `git push`。

## 安装

运行 `npm install`、`npm run package`，然后在 VS Code 中执行“Extensions: Install from VSIX”，选择生成的 `ai-git-commit-0.1.3.vsix`。要求 VS Code 1.96+、本地 Git 和启用的内置 Git 扩展。也可在源码目录按 F5 启动 Extension Development Host。

## 首次配置

1. 执行 **AI Git Commit: Select Provider**，选择 OpenAI、DeepSeek、阿里云百炼、硅基流动或自定义服务商。
2. 执行 **AI Git Commit: Configure Model**，填写可用于 Chat Completions 的模型 ID。部分预设提供默认模型，但服务商可能调整模型，请以其文档为准。
3. 自定义服务商须设置 `aiGitCommit.baseUrl`，填写 API 根地址，例如 `https://example.com/v1`。扩展会在末尾添加 `/chat/completions`；已有完整路径不会重复添加。非本机 HTTP 地址会被拒绝。
4. 执行 **AI Git Commit: Set API Key**。输入框会遮蔽密钥，每个服务商的密钥分别存于 VS Code SecretStorage。可再次运行此命令更换密钥，通过 **Check API Key** 查看是否已配置，通过 **Delete API Key** 删除当前服务商密钥。密钥不能写在 `settings.json` 中。
5. 可执行 **Test API Connection** 测试模型；此操作会向服务商发送一条不含代码的短消息，可能产生少量费用。

服务商接口以各自官方文档为准：[OpenAI](https://platform.openai.com/docs/api-reference/chat/create)、[DeepSeek](https://api-docs.deepseek.com/guides/codex)、[阿里云百炼](https://help.aliyun.com/zh/model-studio/model-calling-in-sub-workspace)、[硅基流动](https://docs.siliconflow.cn/docs/api/chat-completions-post)。

## 生成与多仓库

点击 SCM 顶部的 AI 图标，或在命令面板运行 **Generate Commit Message**。若所选仓库有任何暂存文件，只用暂存区生成，忽略所有未暂存修改；只有暂存区为空，才读取已跟踪文件的工作区修改及未跟踪且未被忽略的文件。在具体仓库的 SCM 菜单中运行命令时优先使用该仓库；上下文不明确且打开多个仓库时会显示仓库列表，包含路径与暂存文件数量。支持多根工作区和已由 VS Code Git 扩展识别的嵌套仓库。

进度通知可取消请求，命令面板也提供 **Cancel Generation**。**Regenerate Commit Message** 重新检查暂存优先级并读取当前变更，**Copy Commit Message** 复制所选仓库最近一次生成结果。生成中再次点击同一仓库不会重复请求。所选变更在生成期间改变时会停止填写，要求重新生成。

默认自动填写 SCM 输入框。已有不同提交信息时会询问是否覆盖；可选择仅复制。关闭 `aiGitCommit.autoFill` 后，生成结果只显示并提供“复制”“填写”。扩展不会自动提交或推送。

## 设置

| 设置                              | 默认值       | 说明                                                   |
| --------------------------------- | ------------ | ------------------------------------------------------ |
| `aiGitCommit.provider`            | `custom`     | 服务商预设或自定义                                     |
| `aiGitCommit.baseUrl`             | 空           | 自定义服务商的 API 根地址                              |
| `aiGitCommit.model`               | 空           | 模型 ID；预设可能有默认值                              |
| `aiGitCommit.language`            | `zh-CN`      | 输出语言                                               |
| `aiGitCommit.timeout`             | `120000`     | 单次请求超时，毫秒                                     |
| `aiGitCommit.temperature`         | `0.2`        | 温度值                                                 |
| `aiGitCommit.sendTemperature`     | `false`      | 显式发送温度参数；兼容性需要时开启                     |
| `aiGitCommit.maxDiffLength`       | `30000`      | 单次差异处理字符预算                                   |
| `aiGitCommit.maxContextTokens`    | `16000`      | 单次请求近似 Token 预算                                |
| `aiGitCommit.maxSummaryCalls`     | `10`         | 局部摘要默认上限；超出时可选择仅本次继续               |
| `aiGitCommit.autoFill`            | `true`       | 是否自动填写 SCM                                       |
| `aiGitCommit.confirmOverwrite`    | `true`       | 覆盖已有消息时确认                                     |
| `aiGitCommit.conventionalCommits` | `true`       | 校验 Conventional Commits                              |
| `aiGitCommit.outputFormat`        | `singleLine` | `singleLine` 单行；`prompt` 由提示词定义格式，允许多行 |
| `aiGitCommit.promptFile`          | 空           | 提示词文件路径；相对路径按所选仓库根目录解析           |
| `aiGitCommit.customPrompt`        | 空           | 附加生成规则                                           |

配置变更会在下次请求时生效。只有 API Key 通过命令存入 SecretStorage，绝不在设置里填写。

### 用提示词定义输出格式

如果仓库根目录有 `CODEBUDDY.md`，可在该仓库的 VS Code 设置中配置：

```json
{
  "aiGitCommit.outputFormat": "prompt",
  "aiGitCommit.promptFile": "CODEBUDDY.md",
  "aiGitCommit.conventionalCommits": true
}
```

也可直接把规则写入 `aiGitCommit.customPrompt`，或用绝对路径指定规则文件。`promptFile` 的内容会发送给所选模型；相对路径只能指向该仓库内的文件，文件上限为 16 KiB。选择不同仓库时分别解析文件。默认 `singleLine` 模式仍强制单行；`prompt` 模式允许“标题、空行、功能列表”等多行正文，首行在 `conventionalCommits=true` 时必须为 `type(scope): 描述` 且不超过 80 字符，首行与正文之间必须空一行。提示词中的其他细节由模型遵循，插件无法机械验证任意自然语言规则。

规则文件中要求额外读取本次所选差异之外的文件、运行命令或查看历史的步骤不会执行；代码变更依据只来自本次选定的暂存区或工作区差异。

## 大型差异与隐私

扩展按文件提取所选差异和增删行数。小差异一次生成；大型差异按完整行与近似 Token 预算分组，逐组生成事实摘要，再根据全部摘要和文件清单汇总。Token 估算用于分组，实际用量以服务商计算为准。依赖锁文件（如 `package-lock.json`、`pnpm-lock.yaml`）只发送文件名与变更统计，不发送完整补丁；扩展会提示这一分析限制，依赖意图由同批变更的清单文件辅助判断。二进制文件同样只能分析文件级元数据。超过局部摘要次数上限时，扩展会在请求前告知预计调用次数，并允许仅本次继续；单行预算、单文件 32 MiB 读取限制或过高的请求次数仍会明确报错。每次模型请求都可能收费。

**所选仓库的暂存差异，或在暂存区为空时的未暂存及未跟踪文件内容，会发送到所选服务商的 API 地址。** 使用自定义 Base URL 时，请自行确认服务商的隐私政策和费用。扩展日志仅记录固定事件，不记录密钥、请求体、响应体或代码差异。Git 差异被当作不可信数据，提示词要求模型忽略其中的指令。

## 排查与开发

- “没有暂存或工作区变更”：所选仓库当前没有可生成的变更；被 `.gitignore` 忽略的未跟踪文件不会读取。
- 401/403：检查当前服务商的密钥及模型访问权限。
- 404：检查模型 ID 和 Base URL。根地址末尾通常是 `/v1` 或服务商兼容路径。
- 429：检查限流或余额；扩展会有限退避重试。
- 超时：检查网络、代理或增大 `aiGitCommit.timeout`。
- 结果格式无效：模型会进行一次格式修复，仍失败时显示错误。
- 打开 **AI Git Commit: Show Logs** 查看不含密钥和代码的事件日志。

开发命令：`npm run compile`、`npm run watch`、`npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test`、`npm run package`。集成测试用 `@vscode/test-electron` 启动 Extension Host；可设环境变量 `VSCODE_EXECUTABLE_PATH` 使用已安装 VS Code，避免下载。`.vscode/launch.json` 提供 F5 调试配置。所有 AI 单元测试使用 Mock HTTP，不需要真实 API Key。
