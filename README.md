# PersonalFlow

English | [中文](#中文)

## English

PersonalFlow is a local-first AI communication practice web app.

It helps people rehearse high-stakes conversations such as interviews, promotion reviews, project defenses, debates, and sales discovery calls. The long-term goal is broader than a fixed-template practice app: PersonalFlow aims to make AI roleplay scenarios definable, runnable, reviewable, reusable, and eventually creatable by users with AI.

In other words, PersonalFlow is both:

- a local web app for practicing communication scenarios today;
- an open scenario engineering framework for AI roleplay scenarios over time.

## Product Shape

PersonalFlow runs as a local web app with a React frontend, a Fastify API, and a local SQLite database. It is not a hosted SaaS by default. Your scenarios, materials, sessions, and review reports stay on your machine unless you choose to share them.

## Vision And Current Alpha

The vision is:

> Users should be able to create the exact roleplay scenario they need with AI, run it with multiple AI roles, and receive evidence-based feedback grounded in the actual conversation.

The current alpha already supports the core loop:

- built-in scenario templates;
- structured custom scenario creation through a form-based builder;
- local scenario confirmation and checks;
- multi-role practice sessions;
- material attachment and role/stage visibility controls;
- session branching, withdraw, and replay-style practice;
- evidence-based review reports.

AI-assisted natural-language scenario creation is not complete yet. Voice practice is also planned, but the current open-source alpha focuses on text-based web practice.

## Who It Is For

PersonalFlow is for people who need realistic practice before high-pressure communication.

Primary users include:

- job seekers preparing for interviews and project deep dives;
- professionals preparing for probation, promotion, or project reviews;
- students and researchers preparing for defenses or debate rounds;
- salespeople, consultants, and founders practicing discovery and objection handling;
- coaches, trainers, and team leads who want reusable practice scenarios and review evidence.

There is also a second audience: scenario authors. These are people who want to turn a communication training case into a reusable scenario package with roles, stages, materials, rules, and review dimensions.

## Core Features

- **Multi-role AI practice**: AI can act as interviewers, reviewers, debate opponents, customers, teammates, and judges.
- **Built-in templates**: interviews, promotion reviews, project or thesis defenses, debates, and B2B sales discovery.
- **Structured custom scenarios**: create multi-stage, multi-role scenarios from product-level parameters.
- **Materials and visibility**: attach text materials and decide which role can see the full text, summary, or nothing.
- **Local-first storage**: scenarios, materials, sessions, and reviews are stored in local SQLite.
- **Evidence-based reviews**: review reports cite actual conversation evidence instead of giving generic feedback.
- **Branching and rewriting**: branch from earlier turns, withdraw an answer, and practice alternative responses.
- **Bundled demo database**: explore completed practice sessions and review reports immediately after setup.
- **Model modes**: use deterministic fake mode for local development, or configure your own OpenAI-compatible provider for real practice.

## Quick Start

```bash
pnpm install
pnpm demo:start
```

Open the web app at:

```text
http://127.0.0.1:5173
```

The API health endpoint is:

```text
http://127.0.0.1:3000/health
```

`pnpm demo:start` runs `pnpm demo:setup` first. Setup creates `.env` from `.env.example` if needed and copies the bundled demo database from:

```text
examples/demo/personalflow-demo.sqlite
```

to the API runtime store:

```text
apps/api/.personalflow/personalflow.sqlite
```

Setup does not overwrite an existing `.env` or local SQLite file. To reset back to the bundled demo, stop the dev server, remove `apps/api/.personalflow/personalflow.sqlite`, and run:

```bash
pnpm demo:setup
```

The bundled demo contains three completed practice histories with review reports:

- backend probation review;
- senior backend job interview;
- short-video impact debate.

The demo database does not include a working model credential. Configure your own OpenAI-compatible key in Settings if you want to run new real-model practice sessions.

## Model Modes

`fake` mode is the default for local development and CI. It uses deterministic responses and does not call any external model provider.

```bash
PERSONALFLOW_MODEL_MODE=fake pnpm dev
```

`real` mode uses a saved OpenAI-compatible model configuration from the Settings page. API keys are stored locally and are not returned by product APIs.

```bash
PERSONALFLOW_MODEL_MODE=real pnpm dev
```

Use a stable local encryption key if you save model credentials:

```bash
PERSONALFLOW_LOCAL_ENCRYPTION_KEY=change-me-to-a-32-character-local-key
```

Do not commit real model credentials.

## Repository Layout

```text
apps/
  api/        Fastify product API
  web/        React + Vite web app
packages/
  agent/      LLM adapter and AgentAction parsing
  contracts/  shared runtime and API contracts
  review/     review report generation
  runtime/    deterministic scenario runtime
  storage/    SQLite repositories
  templates/  built-in scenario templates and fixtures
tests/
  e2e/        Playwright product flows
```

## Requirements

- Node.js 20 or newer
- pnpm 10 or newer
- macOS, Linux, or Windows with a working native build toolchain for `better-sqlite3`

## Development Commands

```bash
pnpm test:run
pnpm typecheck
pnpm build
pnpm e2e
pnpm release:gate
```

`pnpm release:gate` runs the full project gate:

1. Vitest suite
2. TypeScript checks
3. Production build
4. Playwright Chromium install check
5. Playwright E2E tests

## Security And Privacy

- Local practice data is stored in SQLite on the user's machine.
- Model credentials are intended to stay local.
- Product APIs should not return raw provider responses, raw prompts, authorization headers, or API keys.
- `.personalflow/`, `.tmp/`, `.env`, logs, and upload scratch space are ignored by git.

Please read [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## Contributing

Contributions are welcome while the project is in alpha. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and run `pnpm release:gate` before opening a pull request.

## License

MIT. See [LICENSE](LICENSE).

## 中文

PersonalFlow 是一个本地优先的 AI 沟通演练 Web App。

它帮助用户练习面试、转正/晋升答辩、项目评审、论文答辩、辩论赛、销售探索等高压沟通场景。它的长期目标不只是提供几个固定模板，而是让 AI Roleplay 场景可以被定义、运行、复盘、复用，并最终让用户可以通过 AI 创建自己想要的演练场景。

换句话说，PersonalFlow 同时是：

- 当前可用的本地沟通演练 Web App；
- 面向未来的 AI Roleplay 场景工程化框架。

## 产品形态

PersonalFlow 以本地 Web App 的形式运行，由 React 前端、Fastify API 和本地 SQLite 数据库组成。它默认不是托管 SaaS。你的场景、材料、演练记录和复盘报告都会保存在本机，除非你主动导出或分享。

## 目标与当前现状

产品目标是：

> 用户可以用 AI 创建自己需要的多角色沟通演练场景，完成真实演练，并基于对话证据获得可复核的复盘反馈。

当前 alpha 版本已经跑通核心闭环：

- 内置场景模板；
- 通过结构化表单创建复杂自定义场景；
- 场景确认和开始前检查；
- 多角色演练流程；
- 材料附加和按角色/阶段配置可见性；
- 演练分支、撤回、重写和重练；
- 基于真实对话证据生成复盘报告。

自然语言 AI 创建场景还没有完整完成。语音演练也是后续方向；当前开源 alpha 版本以文本 Web 演练为主。

## 目标用户

PersonalFlow 面向需要在真实高压沟通前提前练习的人。

主要用户包括：

- 求职者：准备面试、自我介绍、项目经历深挖、系统设计追问；
- 职场人：准备转正答辩、晋升答辩、项目复盘或评审；
- 学生和研究者：准备论文答辩、项目答辩、辩论赛；
- 销售、顾问和创业者：练习客户发现、异议处理、方案沟通；
- 教练、培训者和团队负责人：沉淀可复用的沟通训练场景和复盘样例。

PersonalFlow 也面向场景作者：他们可以把一个沟通训练案例沉淀成包含角色、阶段、材料、规则和复盘维度的可复用场景资产。

## 核心功能

- **多角色 AI 演练**：AI 可以扮演面试官、评委、反方辩手、客户、队友和裁判。
- **内置模板**：支持求职面试、转正答辩、项目/论文评审、辩论赛、B2B 销售探索等场景。
- **结构化自定义场景**：通过产品级参数创建多阶段、多角色、多轮追问的复杂场景。
- **材料与可见性**：附加文本材料，并控制不同角色看到全文、摘要或完全不可见。
- **本地优先存储**：场景、材料、演练记录和复盘报告保存在本地 SQLite。
- **证据化复盘**：复盘结论引用真实对话片段，而不是泛泛评价。
- **分支与重写**：可以从历史轮次分支、撤回答案，并练习另一种回应方式。
- **内置 Demo 数据库**：启动后即可查看已完成演练和复盘报告。
- **模型模式**：支持确定性 fake 模式，也支持配置自己的 OpenAI-compatible 真实模型。

## 快速开始

```bash
pnpm install
pnpm demo:start
```

打开 Web App：

```text
http://127.0.0.1:5173
```

API 健康检查地址：

```text
http://127.0.0.1:3000/health
```

`pnpm demo:start` 会先运行 `pnpm demo:setup`。setup 会在需要时从 `.env.example` 创建 `.env`，并把内置 demo 数据库从：

```text
examples/demo/personalflow-demo.sqlite
```

复制到 API 运行时目录：

```text
apps/api/.personalflow/personalflow.sqlite
```

setup 不会覆盖已有 `.env` 或本地 SQLite。若要恢复到内置 demo，请先停止 dev server，删除 `apps/api/.personalflow/personalflow.sqlite`，然后运行：

```bash
pnpm demo:setup
```

内置 demo 包含 3 组已完成演练和复盘报告：

- 后端工程师转正答辩；
- 高级后端工程师求职面试；
- 短视频普及利弊辩论赛。

demo 数据库不包含可用模型凭据。如果你想创建新的真实模型演练，请在设置页配置自己的 OpenAI-compatible key。

## 模型模式

`fake` 模式是本地开发和 CI 的默认模式。它使用确定性回复，不调用外部模型服务。

```bash
PERSONALFLOW_MODEL_MODE=fake pnpm dev
```

`real` 模式会使用设置页保存的 OpenAI-compatible 模型配置。API key 保存在本地，不会通过产品 API 返回。

```bash
PERSONALFLOW_MODEL_MODE=real pnpm dev
```

如果你要在本地保存模型凭据，请使用稳定的 32 个字符以上本地加密 key：

```bash
PERSONALFLOW_LOCAL_ENCRYPTION_KEY=change-me-to-a-32-character-local-key
```

不要提交真实模型凭据。

## 仓库结构

```text
apps/
  api/        Fastify 产品 API
  web/        React + Vite Web App
packages/
  agent/      LLM adapter 和 AgentAction 解析
  contracts/  共享运行时和 API 契约
  review/     复盘报告生成
  runtime/    确定性场景运行时
  storage/    SQLite 存储层
  templates/  内置场景模板和样例
tests/
  e2e/        Playwright 产品流程测试
```

## 环境要求

- Node.js 20 或更新版本
- pnpm 10 或更新版本
- macOS、Linux 或 Windows，并具备可编译 `better-sqlite3` 的本地构建工具链

## 开发命令

```bash
pnpm test:run
pnpm typecheck
pnpm build
pnpm e2e
pnpm release:gate
```

`pnpm release:gate` 会运行完整门禁：

1. Vitest 测试
2. TypeScript 检查
3. 生产构建
4. Playwright Chromium 安装检查
5. Playwright E2E 测试

## 安全与隐私

- 演练数据保存在用户本机 SQLite。
- 模型凭据设计为只保存在本地。
- 产品 API 不应返回原始模型响应、原始 prompt、authorization header 或 API key。
- `.personalflow/`、`.tmp/`、`.env`、日志和上传临时目录都会被 git 忽略。

漏洞报告请先阅读 [SECURITY.md](SECURITY.md)。

## 贡献

项目仍处于 alpha 阶段，欢迎贡献。提交 PR 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，并运行 `pnpm release:gate`。

## License

MIT。详见 [LICENSE](LICENSE)。
