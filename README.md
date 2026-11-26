# 硬件分析师 (Hardware Data Sheet Analyzer)

基于 **EdgeOne Pages** 的智能硬件数据手册解析工具。上传芯片数据手册 PDF，自动提取关键信息并生成可参考的驱动函数与初始化代码。

v2 是一次整体重构：多供应商自动兜底、长手册智能取段、结构化输出稳健化、管理后台可视化配置与连通性自检。

## 功能特性

- 📄 **PDF 数据手册上传** — 拖拽或点击上传，文本在浏览器本地提取（不上传原文件），显示页数与字数
- 📚 **长手册智能取段** — 超长手册不再无脑截断前半部分：按关键词密度（寄存器、引脚、电气参数、时序、接口等）自动选取关键页，封面特性页与末页必选
- 🤖 **多供应商自动兜底** — SenseNova（商汤）、DeepSeek 官方、Google Gemini、OpenRouter、任意 OpenAI 兼容服务，按顺位依次尝试，一家超时或报错自动切下一家
- 🩺 **连通性自检** — 管理后台可从边缘函数所在位置探测每家供应商的连通性与延迟，"连不上"当场可见原因
- ⚡ **驱动代码生成** — 针对目标 MCU 与语言生成 2–4 个核心驱动函数 + 完整初始化代码，支持代码高亮、一键复制、整包下载
- 🛡️ **输出稳健化** — JSON 模式 + 容错提取 + 一次自动修复，模型输出不规范时呈现原文而不是整页报错
- 📊 **管理后台** — 密码登录（哈希存储、会话 24 小时过期），供应商 Key/模型/顺位配置、每日限额、调用统计
- 🔐 **防盗刷** — 分析接口可开启访问口令，避免公开地址被他人消耗额度
- 🕘 **历史记录** — 最近 10 次分析结果保存在浏览器本地，刷新不丢失

## 项目结构

```
hardware/
├── index.html                    # 前端主页
├── admin.html                    # 管理后台
├── css/
│   └── style.css                 # 全局样式（深色主题）
├── js/
│   ├── app.js                    # 前端主逻辑（PDF 提取、智能取段、结果渲染、历史）
│   └── admin.js                  # 管理后台逻辑
└── edge-functions/
    ├── _shared/
    │   ├── http.js               # CORS、JSON 响应、KV 访问
    │   ├── store.js              # 配置（单 JSON 文档）、计数、密码与会话
    │   ├── providers.js          # 供应商预设、调用兜底、连通性探测
    │   └── prompt.js             # 提示词、JSON 提取与结果归一化
    └── api/
        ├── analyze.js            # 核心分析接口
        └── admin/
            ├── login.js          # 管理员登录
            ├── config.js         # 配置读写
            ├── stats.js          # 调用统计与重置
            └── test.js           # 供应商连通性测试
```

## 技术栈

| 组件 | 技术 |
|------|------|
| 部署平台 | EdgeOne Pages（国际站） |
| 边缘运行时 | EdgeOne Edge Functions |
| 数据存储 | EdgeOne Pages KV（绑定名 `AI_HARDWARE_TOOL`） |
| 前端 | 原生 HTML + CSS + JavaScript，PDF.js 提取文本，highlight.js 代码高亮 |
| AI 引擎 | OpenAI 兼容接口：SenseNova / DeepSeek / Gemini / OpenRouter / 自定义 |

## 部署步骤

### 1. 创建 EdgeOne Pages 项目

1. 登录 [EdgeOne Pages 控制台](https://pages.edgeone.ai/)
2. 新建项目 → 连接 Git 仓库 → 选择本项目仓库
3. 项目名称：`hardware-analyzer`

### 2. 创建并绑定 KV 存储

1. 控制台 → **KV 存储**，创建命名空间（如 `AI_HARDWARE_TOOL`）
2. 项目设置 → **KV 绑定**：变量名 `AI_HARDWARE_TOOL`，选择该命名空间
3. 保存后重新部署项目

### 3. 初始配置

1. 访问部署地址的 `/admin.html`，默认密码 `admin123`（登录后请立即修改；密码以哈希形式存储）
2. 在「供应商配置」中至少为一家供应商填写 API Key 与模型，并点「测试连接」确认从函数侧连通
3. 按需调整调用顺位、每日上限与分析访问口令

> 从 v1 升级无需任何手动迁移：首次启动时，老版本散存在 KV 中的 OpenRouter Key、模型与限额会自动并入新配置，且老密码在首次成功登录后自动升级为哈希存储。

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/analyze` | POST | 分析数据手册（参数：text, mcu, language；启用口令时需带 `X-Access-Code` 头） |
| `/api/admin/login` | POST | 管理员登录（参数：password） |
| `/api/admin/config` | GET/POST | 读取/修改配置（需 Authorization） |
| `/api/admin/stats` | GET/POST | 调用统计/重置（需 Authorization） |
| `/api/admin/test` | POST | 供应商连通性测试（需 Authorization，参数：provider） |

## 使用流程

1. 打开主页，上传硬件数据手册 PDF（本地提取文本，显示页数与字数）
2. 选择或输入目标 MCU 型号，选择编程语言
3. 点击「开始解析」，等待 AI 分析（结果区会标明实际供数的供应商与耗时，兜底记录可见）
4. 查看分块卡片：芯片信息、工作原理、驱动函数（可变数量）、初始化代码、注意事项；可整包下载代码
5. 历史记录保存在本地，可随时回看

## 注意事项

- 仅支持文本型 PDF，扫描件/图片型 PDF 无法提取文本
- 单次分析文本上限约 12 万字符（前端智能取段后），后端硬上限 15 万字符
- 各供应商的可用性取决于部署区域到其接口的网络连通性，请以管理后台「测试连接」的结果为准
- API Key 只存储在 KV 中，不硬编码在代码里；管理后台读取配置时只返回掩码

## License

MIT License
