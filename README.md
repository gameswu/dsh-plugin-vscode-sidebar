# dsh-plugin-vscode-sidebar

VSCode 风格的 DSH Web 侧边栏插件（fork 自 `dsh-plugin-vscode-sidebar` v0.12.1）。

## 项目简介

为 DSH（DeepSeek Harness）Web 界面提供右侧栏 + 底部面板双工作台：

- **文件浏览器**：懒加载目录树 + vscode-icons 按文件类型图标；支持**新建文件/文件夹、重命名、删除**（删除需确认）；在 git 仓库中按 `.gitignore` 将被忽略的文件低亮度灰显（类似 VSCode，仍保留在列表中），并显示 git 状态字母徽章
- **编辑器**：Monaco（VSCode 同源编辑器）文本编辑，全语言语法高亮；tab 标题显示未保存圆点，Ctrl+S 保存；关闭含未保存改动的 tab 时询问保存（可在设置中改为**自动保存**）；图片 / Markdown / HTML / PDF 内联预览
- **Markdown 预览**：DSH 渲染器 + KaTeX 数学公式与图片渲染；文档内的**相对链接与文件提及可直接跳转**打开对应文件
- **源代码管理**：类 VSCode Git 面板——彩色状态徽章、`+a −d` 行数统计、行内 diff、提交、分支切换（含 ahead/behind）、**历史记录泳道轨迹图**；自动探测子目录中的 git 仓库（可配置排除目录）
- **终端**：xterm.js + node-pty 真实 shell，可选为模型注入 `terminal_*` 工具
- **内嵌浏览器**：沙箱 iframe 多开网页 tab
- **任务管理**：subagent 拓扑 + 后台任务卡片；点击卡片展开**终端风格流式输出**（可设置新任务自动展开），代理创建的终端同样在此流式展示
- 全部设置接入官方插件配置页，**修改后即时生效**，无需重启

界面文案跟随 DSH 语言（zh/en）实时切换；面板布局按会话持久化。

## 仓库结构

```
├── src/
│   ├── index.ts            host 半入口：/sidebar API 路由、挂载、设置
│   ├── git.ts              仓库探测 / 状态 / numstat / check-ignore 等 git 操作
│   ├── fs-tree.ts          目录列举（.git 元数据过滤）
│   ├── bundle-route.ts     /sidebar/bundle 懒加载 chunk 与 /sidebar/icons 图标路由
│   ├── wire.ts / config.ts / prefs-shared.ts / trust-fence.ts / ...
│   └── client/
│       ├── index.tsx       client 半入口：portal 侧边栏外壳
│       ├── Sidebar.tsx     面板外壳 / 工作台 / tab 图标解析
│       ├── GitView.tsx     源代码管理面板（含历史轨迹图渲染）
│       ├── git-graph.ts    历史泳道图纯构建器
│       ├── ExplorerView.tsx / file-icons.tsx / DiffView.tsx / DiffTab.tsx / EditorHost.tsx / ...
│       ├── builtins/       7 个内置 tab 注册
│       ├── locales.ts / sidebar.module.css / ...
│       └── chunks/         终端 / 编辑器懒加载入口
├── assets/vscode-icons/    vscode-icons SVG 图标集（含 LICENSE）
├── tests/                  vitest 单元/组件测试
├── scripts/                check-consumer-types.sh（消费者类型面守卫）
├── cordis.patch.yml        bundle 挂载补丁（dsh.bundle.patch，安装必需）
├── tsdown.config.ts        host/client/chunk 三组构建配置
└── package.json            dsh.bundle.patch 声明 + peer 依赖
```

## 安装

本插件是一个自带补丁层的**组合包**（`dsh.bundle` + `cordis.patch.yml`）。用 `dsh plugin` 安装即可——它把参数转发给 profile 的 pnpm，并自动把包挂载进 `dsh.profile.bundles`，无需手动编辑任何配置文件：

```bash
# 从本地路径安装（<路径>/dsh-plugin-vscode-sidebar 为本仓库目录）
dsh plugin --profile web add <路径>/dsh-plugin-vscode-sidebar

# 或从 GitHub 安装（建议锁定 commit）
dsh plugin --profile web add github:gameswu/dsh-plugin-vscode-sidebar#<sha>
```

从 GitHub 安装时，pnpm 会在安装后运行本包的 `prepare` 脚本构建 `lib/`；pnpm ≥10 默认拒绝执行，首次 `add` 会失败并提示把包键加入该 profile 的 `pnpm-workspace.yaml` 后重试：

```yaml
allowBuilds:
  dsh-plugin-vscode-sidebar: true
  node-pty: true
  protobufjs: true
```

> 授权构建意味着安装时会在你的机器上执行本包的构建脚本——请只对可信来源授权。

安装完成后重启 Web 界面（`dsh web`）即可生效。

卸载：`dsh plugin --profile web remove dsh-plugin-vscode-sidebar`（插件行随 bundle 一并移除）。

## 更新与开发

```bash
pnpm install        # 安装依赖
pnpm build          # 打包 → lib/（host/client/chunk 三组构建）
pnpm test           # vitest 单元/组件测试
```

本地路径安装（pnpm link）会直接使用本仓库的构建产物：host 半改动需重启 `dsh web`；仅 client 半改动重新构建后硬刷新浏览器（Ctrl+Shift+R）即可。

## License

[MIT](LICENSE)
