# 硬件分析师 (Hardware Data Sheet Analyzer)

基于 **EdgeOne Pages** + **OpenRouter** 的智能硬件数据手册解析工具。自动解析硬件芯片数据手册 PDF，生成驱动函数代码、初始化代码和硬件信息分析。

## 功能特性

- 📄 **PDF 数据手册上传** — 支持拖拽或点击上传 PDF 文件
- 🤖 **AI 智能分析** — 调用 OpenRouter 大模型 API 自动提取芯片关键信息
- ⚡ **驱动代码生成** — 针对目标 MCU 和编程语言，自动生成两个核心驱动函数 + 完整初始化代码
- 🔧 **多平台支持** — 支持 C / Arduino / STM32 HAL / Python (MicroPython) / ESP-IDF / Rust
- 📊 **管理后台** — 带密码登录的管理面板，支持 API Key 配置、调用统计、限额设置
- 💾 **KV 持久化** — 所有配置和统计数据存储在 EdgeOne KV 中

## 项目结构

```
hardware/
├── index.html                    # 前端主页 - 上传与分析
├── admin.html                    # 管理后台
├── css/
│   └── style.css                 # 全局样式（深色主题）
├── js/
│   ├── app.js                    # 前端主逻辑（PDF 解析、API 调用）
│   └── admin.js                  # 管理后台逻辑
└── edge-functions/
    └── api/
        ├── analyze.js            # 核心分析接口（PDF → AI → 结果）
        └── admin/
            ├── login.js          # 管理员登录
            ├── config.js         # 配置管理（API Key、模型、限额）
            └── stats.js          # 调用统计与重置
```

## 技术栈

| 组件 | 技术 |
|------|------|
| 部署平台 | EdgeOne Pages（边缘计算） |
| 边缘运行时 | EdgeOne Edge Functions（Worker） |
| 数据存储 | EdgeOne Pages KV Storage |
| 前端 | 原生 HTML + CSS + JavaScript |
| PDF 解析 | PDF.js（前端浏览器端） |
| AI 引擎 | OpenRouter API（多模型支持） |

## 部署步骤

### 1. 创建 EdgeOne Pages 项目

1. 登录 [EdgeOne Pages 控制台](https://pages.edgeone.ai/)
2. 新建项目 → 连接 Git 仓库 → 选择本项目仓库
3. 项目名称：`hardware-analyzer`

### 2. 创建并绑定 KV 存储

1. 控制台左侧导航 → **KV 存储**
2. 创建命名空间：`AI_HARDWARE_TOOL`
3. 进入项目设置 → **KV 绑定**
4. 添加绑定：
   - 变量名：`AI_HARDWARE_TOOL`
   - 选择命名空间：`AI_HARDWARE_TOOL`
5. 保存后**重新部署项目**

### 3. 初始配置

1. 访问部署地址的 `/admin.html`
2. 默认密码：`admin123`（建议首次登录后修改）
3. 在「API 配置」中填写：
   - **OpenRouter API Key**：从 [openrouter.ai/keys](https://openrouter.ai/keys) 获取
   - **使用模型**：推荐 `openai/gpt-4o` 或 `google/gemini-2.0-flash-001`
   - **每日调用上限**：默认 100 次

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/analyze` | POST | 分析 PDF 数据手册（参数: text, mcu, language） |
| `/api/admin/login` | POST | 管理员登录（参数: password） |
| `/api/admin/config` | GET/POST | 获取/修改配置（需 Authorization） |
| `/api/admin/stats` | GET/POST | 获取统计/重置计数（需 Authorization） |

## 使用流程

1. 打开主页，上传硬件数据手册 PDF
2. 选择目标 MCU 型号（如 STM32F103C8T6）
3. 选择编程语言（C / Arduino / STM32 HAL 等）
4. 点击「开始解析」，等待 AI 分析完成
5. 查看分块卡片展示的分析结果：
   - 芯片基本信息（型号、用途、供电、温度范围、通信方式、引脚说明）
   - 工作原理简介
   - 两个核心驱动函数代码（可一键复制）
   - 完整初始化代码（可一键复制）
   - 使用注意事项

## 注意事项

- PDF 仅支持文本型 PDF，扫描件/图片型 PDF 无法提取文本
- 单次分析文本限制为 80000 字符，超长内容会自动截断
- API Key 和所有配置存储在 KV 中，不会硬编码在代码中
- 默认管理员密码 `admin123`，生产环境请务必修改

## License

MIT License
