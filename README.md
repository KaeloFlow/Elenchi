# Elenchi

苏格拉底式 AI 学习应用。核心理念："最难的知识由自己想通"。

导入自己的 Markdown 教材，Elenchi 按章节整理知识点并排成课程；课堂上 AI 不直接给答案，
而是通过追问引导你自己推理。课堂记录和闪卡保存在本机。

## 下载

前往 [Releases](https://github.com/KaeloFlow/Elenchi/releases) 下载对应平台的安装包：

- Windows：`Elenchi-Setup-<版本>.exe`
- macOS：`Elenchi-<版本>.dmg`
- Linux：`Elenchi-<版本>.AppImage`

使用前需要准备一个 OpenAI 兼容的 AI 服务（Base URL、API Key、模型名），首次启动时在应用内填写。
教材和学习记录保存在本机；对话时，教材片段和你的回答会发送给你配置的 AI 服务。

> 当前安装包尚未做代码签名：Windows 可能弹出 SmartScreen 提示（点“更多信息”→“仍要运行”），
> macOS 需要在“系统设置 → 隐私与安全性”中允许打开。

面向用户的功能说明与常见问题见 `docs/product/elenchi-product-faq.md`。

## 技术栈

- Monorepo：pnpm workspaces
- 前端：React + Vite + TypeScript
- 后端：Fastify + TypeScript
- 存储：SQLite（better-sqlite3）+ Drizzle ORM
- 测试：Vitest

## 本地开发

```bash
pnpm install

# 生成并应用数据库迁移（首次运行）
pnpm db:generate
pnpm db:migrate

# 启动后端（默认动态端口，可用 ELENCHI_PORT 固定）
pnpm dev:server

# 另一个终端，启动前端（默认 http://localhost:5173）
pnpm dev:web
```

前端通过 Vite dev proxy 将 `/api/*` 转发到后端；生产环境下前端只使用相对路径调用
API，因此浏览器访问和未来的 Electron 内嵌 WebView 都无需改代码。

## 环境变量

| 变量 | 作用 | 默认值 |
|---|---|---|
| `ELENCHI_DATA_DIR` | 本地数据目录（SQLite库、教材、导出文件） | `./data` |
| `ELENCHI_PORT` | 后端端口，`0` 或不设为自动分配空闲端口 | `0` |
| `ELENCHI_HOST` | 后端绑定地址 | `127.0.0.1` |
| `ELENCHI_SERVER_URL` | 前端开发代理目标（仅 dev 用） | `http://127.0.0.1:4000` |

## Electron 打包与分发

当前已提供 Electron 壳，复用同一套 server + web 构建产物：

```bash
# 构建 web、server 与 Electron 主进程
pnpm build:desktop

# 生成未安装目录（适合本地冒烟检查）
pnpm --filter @elenchi/desktop pack

# 生成当前平台安装包
pnpm dist:desktop
```

Electron 主进程会启动一个本地 server 子进程，数据目录默认为 Electron 的
`userData/data`，不会写入安装目录。开发阶段可用 `ELENCHI_DESKTOP_URL` 让桌面壳加载
已有的 web 开发服务器，例如 `ELENCHI_DESKTOP_URL=http://localhost:5173 pnpm dev:desktop`。

### 自动更新

打包后的应用启动时会通过 `electron-updater` 检查
[GitHub Releases](https://github.com/KaeloFlow/Elenchi/releases) 上的新版本，后台下载，退出应用时安装。
仓库地址来自 `apps/desktop/package.json` 的 `build.publish` 配置；开发模式不检查更新，
设置 `ELENCHI_DISABLE_UPDATES=1` 可关闭。

### 发布新版本

1. 修改 `apps/desktop/package.json` 中的 `version`（例如 `0.2.0`）并提交。
2. 推送同名标签：`git tag v0.2.0 && git push origin v0.2.0`。
3. GitHub Actions（`.github/workflows/release.yml`）会在 Windows、macOS、Linux 上构建安装包，
   上传到一个草稿 Release。
4. 在 GitHub 的 Releases 页面检查草稿、填写更新说明，然后点击 “Publish release”。

代码签名与 macOS 公证尚未配置。

## 目录结构

```
Elenchi/
├── apps/
│   ├── web/          # React + Vite 前端
│   ├── server/       # Fastify 后端
│   └── desktop/      # Electron 桌面壳
├── packages/
│   └── shared/       # 前后端共享类型
├── docs/product/     # 产品 FAQ
├── .github/workflows/ # CI 与发布流程
├── scripts/          # 端到端冒烟脚本
└── data/             # 本地数据（运行时生成，已 gitignore）
```

## 许可证

[MIT](LICENSE)
