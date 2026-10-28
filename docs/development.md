# Rivu 开发环境

当前在 main 上用小提交推进。环境由助手准备，媒体与网络功能由作者亲手实现。README 保留最小项目介绍。

## 安装与运行

先加载本机 nvm，然后在仓库根目录执行：

```sh
nvm install
nvm use
npm ci
npm run check
```

`.nvmrc` 固定 Node 24.22.1；其随附 npm 为 11.19.1。`engines` 与 `.npmrc` 的 engine-strict 会拒绝旧版本的安装，不应通过 force 跳过。nvm 并排安装版本，不删除旧项目使用的 Node；已经打开的终端需要自行执行 nvm use。

| 命令 | 用途 |
|---|---|
| npm run dev | 用 tsx 执行 TS 入口；当前入口只是空占位，成功时没有业务输出 |
| npm run typecheck | 严格类型检查，不执行程序、不生成文件 |
| npm run build | 将 src 编译到 dist；测试文件不进入构建 |
| npm start | 运行构建后的 JavaScript；先运行 build |
| npm test | 用 Node 内置测试运行器执行测试；当前尚无业务测试 |
| npm run check | 顺序运行类型检查、构建与测试命令 |
| npm run audit | 查询 npm 注册表中的已知依赖漏洞 |

相对模块导入使用输出文件扩展名，例如从另一个 TS 文件导入 `./example.js`，由 NodeNext/tsx 解析；运行代码与构建产物都使用 ESM。以后按需要增加测试，采用 `tests/name.test.ts` 命名。

## 版本与安全边界

2026-10-28 核对了 [Node 24.22.1 官方安全版本](https://nodejs.org/en/blog/release/v24.22.1/) 与 [2026 年 10 月安全公告](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)。24.22.1 修复了相关 DNS、TLS、Brotli 等问题，本项目不再以 24.16.0 为环境基线。

直接开发依赖固定版本，并保存 package-lock.json 中的依赖树和完整性哈希。日常安装使用 npm ci；新增依赖前检查来源、维护与兼容性，再进行审计。未配置自动升级任务。

安装默认禁止依赖生命周期脚本（ignore-scripts=true）；显式 npm run 命令仍可以执行。当前依赖应在这个限制下完成安装和运行验证；以后引入原生依赖时需逐项审查安装要求，不能直接全局放开。

npm audit 只检查其数据库覆盖的包依赖，不检查 Node 运行时或 FFmpeg/FFplay 外部程序，也不证明不存在未知漏洞。安全更新发布后，需要重新核对并更新 .nvmrc、engines、packageManager 和 lockfile；精确锁版本不是停止维护的理由。

`.gitignore` 排除依赖、编译结果、本地配置、密钥与生成媒体目录；不会忽略全部图片/视频，因此有意添加的小 fixture 仍可被版本控制。私密素材只能放在忽略的输出目录里，不应作为测试 fixture。

## 第一个手写任务

修改 src/cli/main.ts，让它输出一条 Rivu 启动信息。随后分别运行 dev、check，以及 build 后的 start，理解直接执行 TS、类型检查、运行构建产物之间的区别。环境占位不计作完成媒体功能。
