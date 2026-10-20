# 参与贡献

欢迎通过 Issue 报告问题或提出改进，再通过 Pull Request 提交修改。安全漏洞请按 [SECURITY.md](SECURITY.md) 私密报告。

## 本地验证

使用 Node.js 24 和 npm，执行：

```powershell
npm ci
npm run compile
npm run lint
npm run format:check
npm run test:unit
npm run test:integration
npm run package
```

集成测试会启动 VS Code Extension Host；可通过 `VSCODE_EXECUTABLE_PATH` 指向本机 VS Code，或让测试工具下载测试版本。测试应使用 Mock API，不提交或共享真实 API Key。

## 提交要求

- 变更需包含与行为相符的测试，并保持现有 SCM 输入框、多仓库和密钥存储行为。
- 不要提交 `node_modules`、`out`、`.vscode-test`、VSIX 或任何密钥文件。
- PR 描述请写明变更目的、验证命令和仍未验证的真实服务商行为。不要附带敏感代码内容或凭据。
