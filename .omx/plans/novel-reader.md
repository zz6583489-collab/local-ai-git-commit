# 小说阅读器功能规划

## 目标与边界

在现有 AI Git Commit 扩展中增加一个可选的本地小说阅读模块。用户已选择**编辑区标签页**作为主阅读界面。打开阅读器不要求 Git 仓库、AI Key 或模型配置；现有扩展仍要求内置 `vscode.git` 扩展处于启用状态。阅读正文不进入提交信息生成流程、AI 请求或日志。

现已增加阅读器命令、编辑区 Webview 阅读标签和状态栏“继续阅读”入口。`src/config/settings.ts` 会校验 AI 服务商、地址和模型；阅读设置独立保存在扩展 `globalState` 中。

## 功能优先级

| 阶段 | 功能 | 用户可见行为 |
| --- | --- | --- |
| MVP | 导入小说目录 | 一个目录是一本书；直接子级的所有 `.txt` 按自然数字顺序组合，每个文件是一章，不复制正文到仓库。 |
| MVP | 最近书籍 | 命令面板弹出可搜索列表；可打开、重新定位丢失文件、移除记录；移除记录不删除原文件。 |
| MVP | 编辑区阅读标签 | 每本书在编辑区显示阅读页；重复打开同一本书定位到已有标签；支持连续滚动、上一/下一章、目录跳转。 |
| MVP | 中文 TXT 兼容 | 优先识别 UTF-8/BOM，支持 GB18030 手动切换；章节标题来自 TXT 文件名。 |
| MVP | 阅读体验 | 字号、行距、正文宽度可调；跟随 VS Code 明暗主题；阅读区有键盘导航和可访问的按钮标签。 |
| MVP | 进度恢复 | 自动保存每本书的目录 URI 和绝对字符偏移；关闭标签后通过状态栏“继续阅读”重新打开。 |
| 下一阶段 | EPUB | 解析 spine/目录/封面；清洗并限制书内 HTML、CSS 和资源；只支持无 DRM 文件。 |
| 下一阶段 | 书签与书内搜索 | 添加/删除书签、跳转结果、按书名与章节搜索。 |
| 下一阶段 | 可视书架与会话恢复 | 需要时增加 Tree View 书架；用 WebviewPanelSerializer 恢复重启前打开的阅读标签。 |
| 待评估 | TTS、跨设备同步、在线书源 | 分别评估语音依赖、用户数据同步、版权与站点维护成本后再决定。 |

首版入口为“打开小说阅读器”“导入小说目录”“继续阅读上一本小说”与状态栏“继续阅读”。书架使用 QuickPick，不占 SCM 菜单。阅读器可在空工作区使用。

## 交互流程

1. 用户执行“导入小说目录”，在文件选择器中选择本地目录；扩展按文件名排序 TXT 章节，只保存目录/进度元数据。
2. 用户执行“打开小说阅读器”，选择最近书籍，编辑区打开阅读标签。首次打开显示开头，后续打开恢复阅读位置。
3. 阅读区左侧显示目录；正文提供上一/下一章、当前章节进度和阅读设置。滚动、切章、关闭标签时保存位置；设置保存到 `globalState`。
4. 目录丢失时显示“重新定位”和“移除记录”；目录内容变化时以绝对字符偏移为基准尽量恢复，并提示位置可能变化。旧单文件书架记录打开时迁移到所属目录。

## 实现顺序与落点

1. **扩展贡献点**：在 `package.json` 增加阅读命令；在 `src/extension.ts` 注册阅读模块，状态栏入口由 `ReaderCommands` 创建。
2. **书籍服务**：`src/reader/txtParser.ts` 解析单个 TXT，`src/reader/folderBook.ts` 按自然顺序组合目录直接子级的 TXT。MVP 仅接受本地 `file:` 目录、合计最大 32 MiB、最多 2000 个章节；Webview 只接收当前阅读窗口。`src/reader/readerState.ts` 使用 `globalState` 保存书架、进度和阅读设置。
3. **阅读标签**：新增 `src/reader/readerPanel.ts`；采用 `WebviewPanel`。静态脚本/样式放 `media/reader/`，通过消息协议处理章节、位置和设置。正文作为纯文本渲染；限制 `localResourceRoots`，设置 CSP，并校验来自 Webview 的消息。
4. **阅读命令与状态**：新增 `src/reader/readerCommands.ts` 和 `src/reader/readerState.ts`；处理导入、最近书籍、重新定位、删除记录及进度恢复。阅读模块不能调用 `readSettings()`，不能依赖 AI Key 或 Git API。
5. **验证与文档**：补 TXT 解析/编码/进度的单元测试和 Extension Host 的命令/标签集成测试；更新 `README.md`。`tsconfig.json:14-15` 只编译 `src/**/*.ts`，`media/reader/` 要在 VSIX 打包清单中核对；现有 `.vscodeignore:4` 排除 `src/**`。

## MVP 验收标准

- 未配置 AI Key，且打开的目录不是 Git 仓库时，仍能导入并阅读 TXT。
- UTF-8、UTF-8 BOM 和 GB18030 测试样本显示正确；乱码时能手动切换编码。
- 目录内 `1.txt`、`2.txt`、`10.txt` 按 1、2、10 排序，每个文件显示为一个目录章节并可跳转。
- 同一本书重复打开只显示一个阅读标签；未修改源文件时，关闭、重启并重新打开后回到同一段落，字符偏移误差不超过 100 字符；源文件变化时提示进度可能偏移。
- 改字号和行距后仍位于同一段落，设置重启后保留；不依赖 VS Code 配置注册表写入。
- 当前章节滚动到结尾时显示 100%，全书进度可在悬停提示中查看。
- 关闭阅读标签后，状态栏“继续阅读”可一键打开最近一本。
- 移除书架记录不会删除或修改源文件；文件丢失时可重新定位。
- 合计 20 MiB 的目录小说可阅读和切章，Webview 不一次接收整本正文。
- 非 `file:` URI、无 TXT 的目录、超过 32 MiB 或 2000 个文件的目录会显示明确的支持范围。
- 阅读操作不发起 AI/网络请求；输出日志和状态存储不含书籍正文。
- `npm run compile`、`npm run lint`、`npm run test:unit`、`npm run test:integration` 和 `npm run package` 通过；检查 VSIX 含 `media/reader/` 所需资源。

## 风险与取舍

- **产品定位**：现有名称、描述、分类和 `vscode.git` 依赖均以提交信息生成器为中心（`package.json:2-28`）。阅读器与 Git 提交关系较弱；先以可选模块验证使用需求，若成为主功能，再考虑拆为独立扩展或调整产品定位。MVP 可在非 Git 工作区阅读，但禁用内置 Git 扩展时是否可用受现有强依赖限制；若要求完全独立，应拆出阅读器扩展。VS Code Webview UX 指南也建议避免增加与编辑器或工作区无关的功能。
- **内容安全**：TXT 与未来 EPUB 均视为不可信输入；正文用文本节点渲染，Webview 使用严格 CSP 与最小资源权限。EPUB 的 HTML 清洗单独实施，不沿用 TXT 渲染假设。
- **性能**：大书按章节或窗口加载，进度使用字符偏移而非仅像素滚动值；避免 `retainContextWhenHidden` 常驻整本内容。
- **路径与编码**：书架保留原目录 URI，目录移动后需重新定位；中文 TXT 的自动编码判断无法保证完全准确，提供显式切换。
- **打包**：新增静态资源必须核对 VSIX 内容；规划文件 `.omx/` 已在 `.vscodeignore` 排除，后续打包仍须检查清单。

## 参考

- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [VS Code 扩展数据存储](https://code.visualstudio.com/api/extension-capabilities/common-capabilities)
- [VS Code Webview UX 指南](https://code.visualstudio.com/api/ux-guidelines/webviews)
- [VS Code Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors)
