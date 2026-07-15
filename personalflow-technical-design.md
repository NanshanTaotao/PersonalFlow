# PersonalFlow 技术方案

最后更新：2026-06-18

## 1. 方案定位

本文是 PersonalFlow 新项目的技术方案，用于指导 MVP 从零落地。

本文不描述旧项目迁移，不沿用旧项目命名，也不包含具体代码片段。文中出现的 Schema、事件和字段定义，均以字段表或结构说明表达，用于明确模块契约。

PersonalFlow 的技术本质是：

- 用户通过自然语言创建个人化互动场景。
- 系统将场景固定成可运行的场景定义。
- 演练时由确定性运行模块控制流程、角色、可见信息和状态推进。
- AI 只负责角色表达、场景创建辅助和复盘文本生成。
- 会话历史以可追溯记录保存，避免静默覆盖，为后续重试、撤回和分支能力预留。

## 2. 设计原则

### 2.1 产品优先

技术结构服务于产品体验。普通用户看到的是场景、角色、流程、演练和复盘，不需要理解内部契约。

### 2.2 确定性控制

AI 可以生成内容，但不能直接拥有流程真相。

系统必须决定：

- 当前轮到谁。
- 当前角色可以做什么。
- 用户输入或 AI 输出是否可接受。
- 接受后状态如何变化。
- 谁能看到哪些历史和材料。
- 会话何时结束。

### 2.3 渐进披露

普通用户只操作自然语言和模板参数。高级用户可以查看和编辑场景配置。模板作者可以组合更底层的执行结构。

### 2.4 可复盘与可重放

会话历史不应只保存最终聊天文本。系统需要保存足够的过程记录，使复盘、调试、重试、撤回和分支在未来可以成立。

### 2.5 MVP 收敛

MVP 聚焦“创建场景 -> 确认场景 -> 运行演练 -> 生成复盘”闭环。

MVP 不做多真人在线协作。多真人参与会显著改变用户输入解释、冲突处理、超时、权限和恢复机制，应作为更远版本的架构升级。

## 3. 总体架构

PersonalFlow 采用本地优先的模块化单体架构。

### 3.1 主要模块

| 模块 | 职责 |
| --- | --- |
| Web App | 首页、模型设置、场景创建、场景预览、演练会话、复盘展示 |
| API Layer | 为前端提供稳定接口，屏蔽内部模块细节 |
| Scene Assistant | 辅助用户通过自然语言创建和修改场景 |
| Template Library | 提供内置模板和模板参数定义 |
| Scenario Builder | 将用户草稿和模板参数转换为可运行场景 |
| Scenario Validator | 检查场景是否可运行，并输出用户可理解的问题 |
| Session Runtime | 运行演练会话，控制角色、流程和状态推进 |
| Agent Layer | 调用 LLM，让 AI 角色生成内容 |
| Context Manager | 为当前角色选择可见历史、材料和状态摘要 |
| Review Engine | 基于会话记录生成复盘报告 |
| Storage | 本地保存模型配置、场景、会话记录和复盘 |

### 3.2 模块关系

| 上游 | 下游 | 说明 |
| --- | --- | --- |
| Web App | API Layer | 前端只调用产品级接口 |
| API Layer | Scene Assistant | 创建和修改场景 |
| Scene Assistant | Scenario Builder | 生成场景草稿或修改草稿 |
| Scenario Builder | Scenario Validator | 确认场景是否可运行 |
| API Layer | Session Runtime | 启动和推进演练会话 |
| Session Runtime | Agent Layer | 请求 AI 角色发言 |
| Session Runtime | Context Manager | 获取当前角色可见上下文 |
| Session Runtime | Storage | 写入会话过程记录 |
| Review Engine | Storage | 读取会话记录并保存复盘 |

### 3.3 技术基线

MVP 的技术基线需要先服务于“可运行、可测试、可追溯”，不追求生产级分布式复杂度。

| 决策项 | MVP 方案 | 原因 |
| --- | --- | --- |
| 应用形态 | 本地优先的 Web App + 本地 API 服务 | 便于快速开发、保存用户本地数据、兼容后续桌面壳 |
| 后端形态 | 模块化单体 | Runtime、Builder、Review 可以共享契约和测试夹具 |
| 存储 | 本地持久化存储 | 支撑草稿、场景、会话事件和复盘记录 |
| Schema 校验 | 统一 Validator 层 | 所有导入、模板展开、AI 生成草稿都走同一检查 |
| LLM 测试 | Fake LLM 作为自动化默认路径 | Runtime 行为不依赖真实模型波动 |
| 调试记录 | 保存 prompt_hash、visibility_hash、context_projection_hash | 支撑问题复现，但不要求 UI 默认展示完整内部细节 |

这些基线约束 MVP 的工程方向：先把确定性 Runtime 跑通，再把模板草稿、复盘和高级编辑叠上去。自然语言场景助手不进入 MVP，作为 Post-MVP 能力在 Runtime 主链路稳定后再接入。

### 3.4 具体技术栈

MVP 采用 TypeScript 本地优先单体技术栈，优先保证契约共享、测试稳定和开发效率，不在第一版引入多语言后端或桌面壳复杂度。

| 层级 | 选型 | 说明 |
| --- | --- | --- |
| 语言 | TypeScript | 前端、API、Runtime、契约和测试使用同一语言，减少跨语言类型漂移 |
| 包管理 | pnpm workspace | 支持 Web、API、shared contracts、fixtures 和测试包拆分 |
| 前端 | React + Vite | 适合本地优先 Web App，启动快，便于后续接 Tauri 或 Electron |
| API 服务 | Node.js + Fastify | 作为本地 API Layer，提供清晰路由、schema 集成和测试入口 |
| 契约校验 | Zod | 定义 NormalizedScenarioV1、StepContractV1、RuntimeEvent、SessionView 等共享契约 |
| 本地存储 | SQLite + Drizzle ORM | SQLite 提供本地事务和可迁移持久化，Drizzle 保持类型可读和迁移可控 |
| LLM 接入 | OpenAI-compatible adapter | MVP 至少支持 OpenAI 兼容接口，真实模型接入与 Runtime 解耦 |
| 自动化模型 | Fake LLM | 单元测试、场景模拟测试和 E2E 默认使用 Fake LLM |
| 单元与契约测试 | Vitest | 覆盖 Validator、Scheduler、Guard、Effect、Visibility、PromptRenderer 和 Runtime replay |
| 端到端测试 | Playwright | 覆盖配置模型、模板创建、确认场景、演练、结束和复盘的最小闭环 |
| API Key 保存 | SQLite 本地加密/隐藏字段 | MVP 不接 macOS Keychain；普通接口只返回 masked 状态或 has_api_key，原始值只供模型调用链路读取 |
| 桌面壳 | MVP 暂不引入 | 先以本地 Web App + 本地 API 服务交付，后续再评估 Tauri 或 Electron |

项目代码建议按职责拆成 workspace 包：

| 包 | 职责 |
| --- | --- |
| apps/web | React 前端页面与产品交互 |
| apps/api | 本地 Fastify API 服务 |
| packages/contracts | 共享 Zod schema、TypeScript 类型和错误码 |
| packages/runtime | Scheduler、Guard、Effect、Terminal、Commit、View Projection |
| packages/agent | Fake LLM、OpenAI-compatible adapter、输出解析和重试策略 |
| packages/storage | SQLite schema、Drizzle migrations、Repository 和事务封装 |
| packages/templates | 内置模板、NormalizedScenarioV1 fixtures 和模板展开逻辑 |
| packages/review | Review Engine、evidence_refs 处理和复盘报告生成 |
| tests/e2e | Playwright 最小闭环测试 |

技术栈边界：

- 不为 MVP 抽象多数据库后端。
- 不为 MVP 引入服务端队列或分布式任务系统。
- 不在前端直接访问 SQLite、LLM 或完整 normalized_scenario。
- 不让 LLM adapter 依赖 Runtime 内部状态实现。
- 不让 Drizzle schema 替代 Zod 运行契约；存储模型和执行契约需要显式映射。

## 4. 核心数据对象

### 4.1 UserSceneDraft

UserSceneDraft 是用户确认前的场景草稿。

| 字段 | 说明 |
| --- | --- |
| draft_id | 草稿 ID |
| title | 草稿标题 |
| source | 来源：模板、自然语言创建、导入 |
| user_goal | 用户想练习或体验的目标 |
| template_id | 使用的模板 ID，可为空 |
| template_params | 用户已确认或 AI 推断的模板参数 |
| participants | 用户和 AI 角色草稿 |
| materials | 用户粘贴或上传的轻量材料 |
| review_preferences | 用户希望如何复盘 |
| status | collecting、preview_ready、needs_fix、ready |
| validation_issues | 当前检查问题 |
| created_at | 创建时间 |
| updated_at | 更新时间 |

### 4.2 SceneTemplate

SceneTemplate 是可复用场景模板。

| 字段 | 说明 |
| --- | --- |
| template_id | 模板 ID |
| name | 模板名称 |
| description | 模板说明 |
| category | 面试、答辩、项目评审、晋升、绩效沟通等 |
| params_schema | 模板参数字段定义 |
| default_params | 默认参数 |
| preview_schema | 模板预览字段 |
| supported_review_modes | 支持的复盘方式 |
| version | 模板版本 |

产品层叫 SceneTemplate，技术层可以把其中的可执行部分理解为 Pattern 参数和展开规则。用户面对的是模板和参数；Scenario Builder 负责把模板参数展开为完整 NormalizedScenarioV1。

关键约束：

- SceneTemplate 不能成为隐藏业务逻辑黑箱。
- 已确认场景必须保存展开后的 normalized_scenario。
- Runtime 只解释 normalized_scenario，不在运行时回头解释模板说明。
- 模板新增能力不能要求修改 Runtime 主流程，应通过 State、Step、Guard、Effect、Scheduler、Visibility 和 Context Projection 表达。

MVP 内置模板：

- 求职面试。
- 论文答辩 / 项目评审。
- 晋升 / 绩效沟通。

### 4.3 ConfirmedScene

ConfirmedScene 是用户点击开始前固定下来的场景版本。

| 字段 | 说明 |
| --- | --- |
| scene_id | 场景 ID |
| scene_version | 场景版本 |
| title | 场景标题 |
| source_draft_id | 来源草稿 ID |
| preview | 用户可读的场景预览快照 |
| normalized_scenario | 运行时使用的可执行场景定义 |
| validation_snapshot | 确认时的检查结果 |
| created_at | 确认时间 |

ConfirmedScene 一旦用于启动会话，不应被后续草稿修改影响。

### 4.4 NormalizedScenarioV1

NormalizedScenarioV1 是运行时唯一解释的可执行场景定义。

它不是普通用户的主要编辑入口，而是模板和草稿确认后的稳定结果。

| 字段 | 说明 |
| --- | --- |
| format_version | 结构版本 |
| constants | 模板参数展开后的运行常量 |
| participants | 参与者实例，包括用户和 AI |
| participant_order | 参与者确定性顺序 |
| roles | 角色定义 |
| resources | 材料、评分规则和工具结果等资源 |
| state_schema | 会话状态结构定义 |
| initial_state | 会话初始状态 |
| steps | 可执行动作定义 |
| scheduler | 当前轮到谁、可以做什么的规则 |
| visibility_rules | 谁能看到哪些事件、状态和资源 |
| context_profiles | 当前角色需要的上下文配置 |
| terminal_rules | 会话结束条件 |
| lifecycle_limits | 会话执行保护限制 |
| review_contract | 复盘所需的最小契约 |

### 4.5 StepContractV1

StepContractV1 是场景中一个最小动作的契约。

| 字段 | 说明 |
| --- | --- |
| name | 动作名称 |
| kind | 动作类型：AI、用户、系统 |
| actor | 谁可以执行该动作 |
| prompt | AI 动作的选择提示和执行说明 |
| args_schema | 动作参数结构 |
| args_ref_paths | 参数中哪些位置是资源引用 |
| preconditions | 动作进入候选集前的条件 |
| accept_when | 动作提交时的接受条件 |
| state_effects | 动作成功后对会话状态的确定性影响 |
| system_args | 系统动作的确定性参数来源 |
| content_forbidden | 是否禁止自然语言内容 |
| context_profile | 使用哪个上下文配置 |
| review_tags | 复盘索引标签 |

### 4.6 RuntimeEvent

RuntimeEvent 是演练会话过程的事实记录。

MVP 至少需要四类事件：

| 事件 | 说明 |
| --- | --- |
| SessionStarted | 会话启动 |
| StepCommitted | 用户、AI 或系统动作被接受并提交 |
| StepAttemptFailed | 用户、AI 或系统动作尝试失败，状态不推进 |
| RuntimeCommandCommitted | 暂停、继续、结束、重试等系统控制行为 |

StepCommitted 的关键字段：

| 字段 | 说明 |
| --- | --- |
| event_id | 事件 ID |
| session_id | 会话 ID |
| branch_id | 分支 ID，MVP 可固定为主分支 |
| actor_id | 执行动作的参与者 |
| step_name | 被接受的动作 |
| content | 用户或 AI 的自然语言内容 |
| args | 结构化参数 |
| resource_refs | 本次动作引用的材料或证据 |
| attempt_no | 同一轮动作的尝试序号 |
| base_state_version | 提交前状态版本 |
| result_state_version | 提交后状态版本 |
| state_patch | 状态变化 |
| visibility_hash | 可见上下文摘要标识 |
| prompt_hash | AI 请求摘要标识 |
| created_at | 事件时间 |

状态版本只在 StepCommitted 或 RuntimeCommandCommitted 成功提交时递增。StepAttemptFailed 用于调试和重试，不改变 committed state，也不影响下一轮候选动作计算。

MVP 不展示分支树，但保留 branch_id，避免未来重试、撤回和 fork 时重写历史。

### 4.7 SessionView

SessionView 是前端读取的会话视图。

| 字段 | 说明 |
| --- | --- |
| session_id | 会话 ID |
| scene_id | 场景 ID |
| branch_id | 当前分支 |
| status | running、paused、ended、failed |
| current_actor | 当前轮到谁 |
| current_stage_label | 当前阶段名称 |
| allowed_user_actions | 用户当前可做动作 |
| visible_transcript | 当前用户可见对话 |
| progress_summary | 场景进度摘要 |
| can_pause | 是否可暂停 |
| can_resume | 是否可继续 |
| can_end | 是否可结束 |
| review_status | 复盘状态 |

前端不自行推断流程，只展示服务端给出的 SessionView。

### 4.8 ReviewReport

ReviewReport 是复盘结果。

| 字段 | 说明 |
| --- | --- |
| review_id | 复盘 ID |
| session_id | 会话 ID |
| branch_id | 复盘对应分支 |
| summary | 总体总结 |
| dimensions | 分维度评价 |
| key_moments | 关键片段 |
| recommendations | 改进建议 |
| evidence_refs | 证据引用 |
| uncertainty_notes | 不确定性说明 |
| created_at | 创建时间 |

复盘应尽量引用会话中的具体片段。

## 5. 关键流程

### 5.1 首次使用与模型配置

1. 用户进入 PersonalFlow。
2. 系统引导用户填写模型配置。
3. 用户执行连接测试。
4. 测试通过后保存配置。
5. 用户进入首页。

关键要求：

- API Key 保存到本地 SQLite 的加密/隐藏字段，MVP 不使用 macOS Keychain。
- API Key 不应在 UI 中反复明文展示；保存后只展示 masked 状态或是否已配置。
- API Key 原始值只允许模型调用链路读取，普通列表、详情、导出、调试接口和日志都不能返回明文。
- 测试失败要给出可读原因。
- MVP 至少支持 OpenAI 兼容接口。

### 5.2 模板创建场景

1. 用户选择 MVP 内置模板。
2. 用户填写或确认模板参数。
3. Scenario Builder 基于模板参数生成 UserSceneDraft。
4. Scenario Validator 输出检查结果。
5. Web App 展示场景预览和问题提示。

关键要求：

- MVP 阶段不做自然语言创建场景。
- MVP 先用极薄求职面试 smoke fixture 驱动 Runtime Core；Runtime 原语跑通后，再补齐求职面试、论文答辩 / 项目评审、晋升 / 绩效沟通三个完整 NormalizedScenarioV1 fixture，验证表达力和防回归。
- 默认值需要在预览中明确标注。
- 场景草稿可以继续修改，不影响已确认场景。

### 5.3 场景确认

1. 用户查看预览和检查结果。
2. 若有阻塞问题，必须先修复。
3. 用户点击开始。
4. 系统生成 ConfirmedScene。
5. 系统保存确认时的场景快照。

关键要求：

- 已确认场景不可被草稿后续修改影响。
- 确认结果必须可追溯到当时的预览和检查状态。

### 5.4 演练会话

1. 用户从 ConfirmedScene 启动 Session。
2. Session Runtime 初始化状态。
3. Runtime 计算当前发言角色和可选动作。
4. Context Manager 准备当前角色可见上下文。
5. AI 角色需要发言时，Agent Layer 调用模型。
6. 用户输入或 AI 输出被验证后，Runtime 提交事件并推进状态。
7. Web App 刷新 SessionView。
8. 会话命中结束条件或用户手动结束。

关键要求：

- AI 不直接决定流程真相。
- 用户只能看到当前会话中应该看到的信息。
- 会话历史追加保存，不静默覆盖。

### 5.5 复盘

1. 用户在会话结束后点击生成复盘。
2. Review Engine 读取会话记录、可见对话和复盘契约。
3. 系统生成复盘报告。
4. Web App 展示总结、维度评价、关键片段和建议。
5. 用户可以重新练习或修改场景。

关键要求：

- 复盘必须尽量引用证据。
- 不确定判断需要标注。
- 复盘失败要允许重试。

## 6. 运行时设计

### 6.1 Runtime 的职责

Runtime 负责：

- 创建会话。
- 计算当前轮次。
- 计算当前角色可选动作。
- 校验用户输入和 AI 输出。
- 推进状态。
- 写入事件。
- 处理暂停、继续和结束。
- 生成前端可用的会话视图。

Runtime 不负责：

- 自由生成场景。
- 自由修改角色规则。
- 直接生成复盘评价。
- 绕过可见性规则拼接上下文。

### 6.2 AI 角色输出协议

AI 角色的输出需要被约束为三部分：

| 字段 | 说明 |
| --- | --- |
| selected_step | AI 选择的动作 |
| content | AI 要说的话 |
| args | 动作需要的结构化参数 |

Runtime 负责检查 selected_step 是否在当前允许范围内，args 是否符合要求，引用是否可见。

### 6.3 用户输入

MVP 以单用户演练为核心。

用户输入分为：

| 类型 | 说明 |
| --- | --- |
| 普通发言 | 用户作为角色参与对话 |
| 结构化动作 | 如投票、选择、确认等明确动作 |
| 系统控制 | 暂停、继续、结束、重新开始 |

普通发言可以被包装为当前用户角色的动作。系统控制不混入普通聊天。

### 6.4 状态推进

每次动作被接受后，Runtime 需要：

- 记录动作内容。
- 计算状态变化。
- 保存过程事件。
- 推进状态版本。
- 重新计算下一轮会话视图。

如果动作不合法，Runtime 不推进状态，并返回可理解的错误。

### 6.5 Schema 字段如何作用于运行流程

NormalizedScenarioV1 不是配置存档，而是 Session Runtime 的执行输入。每个核心字段都必须至少被一个运行模块消费。

| Schema 字段 | 运行时消费者 | 对流程的作用 | 是否进入 AI Prompt |
| --- | --- | --- | --- |
| constants | Guard、Effect、Prompt Renderer | 提供运行常量，例如最大轮次、追问次数、模板参数 | 仅当 prompt 明确引用时进入 |
| participants | Scheduler、Prompt Renderer、SessionView | 决定有哪些参与者、谁是用户、谁是 AI | 当前参与者信息会进入 |
| participant_order | Scheduler | 决定同角色多个参与者的稳定顺序 | 不进入 |
| roles | Prompt Renderer、Review Engine | 提供角色目标、身份和长期行为边界 | 当前角色相关内容会进入 |
| resources | Context Manager、Review Engine | 提供材料、评分规则、可引用内容 | 只有可见资源片段进入 |
| state_schema | State Validator | 校验状态结构，防止非法状态推进 | 不进入 |
| initial_state | Session Runtime | 初始化会话状态 | 不进入 |
| steps | Scheduler、Prompt Renderer、Output Validator、Review Engine | 定义当前可执行动作、动作说明、参数和复盘标签 | 当前 allowed steps 进入 |
| scheduler | Scheduler | 决定当前轮到谁，以及候选动作集合 | 不直接进入 |
| visibility_rules | Visibility Projector、Context Manager、Review Engine | 决定角色能看到哪些事件、状态和资源 | 只影响 Prompt 内容选择 |
| context_profiles | Context Manager | 决定当前 step 需要哪些上下文 | 不直接进入，但决定上下文内容 |
| terminal_rules | Session Runtime | 判断会话是否结束 | 不进入 |
| lifecycle_limits | Session Runtime | 控制最大轮次、自动系统动作、重试上限 | 不进入 |
| review_contract | Review Engine | 定义复盘触发、证据和维度来源 | 不进入演练 Prompt |

判断标准：

- 如果字段影响“谁说话、能做什么、状态怎么变、谁能看到什么、是否结束”，它属于运行流程。
- 如果字段只影响模型本轮怎么表达，它只能通过 Prompt Renderer 进入当前 prompt。
- 如果字段既不影响运行流程，也不影响 prompt、context、validation、review，就不应进入核心 Schema。

### 6.6 可执行语义的最小集合

Runtime 不是读取 prompt 的调度脚本，而是解释 NormalizedScenarioV1 的状态机。MVP 需要把以下四类字段定义到可实现、可测试的程度。

| 语义块 | 解决的问题 | 主要字段 | Runtime 解释方式 |
| --- | --- | --- | --- |
| SchedulerContractV1 | 当前轮到谁、候选动作有哪些 | candidates、actor_selector、step_selector、when、priority | 按确定性顺序扫描候选项，得到 active actor 和 candidate steps |
| GuardExprV1 | 某个动作或结束条件是否成立 | read_scope、op、left、right | 只读 state、constants、actor、event 摘要和提交 args，不调用 LLM |
| StateEffectV1 | 动作成功后状态怎么变 | op、target_path、value、from_args | 只写 state，产出 state_patch，提交前用 state_schema 校验 |
| TerminalRuleV1 | 会话何时结束 | name、when、reason、result_status | 在 tick 开始和动作提交后检查，命中后把 session 标记为 ended |

这四类语义必须保持克制：

- Guard 只能做条件判断，不能修改状态。
- Effect 只能修改 state，不能直接写事件、调用 LLM 或发消息。
- Scheduler 只选择 actor 和 candidate steps，不能生成内容。
- Terminal 只结束会话，不能伪造成某个角色发言。

### 6.7 SchedulerContractV1

Scheduler 的业务意义是把“流程应该如何轮转”从 prompt 中拿出来，变成 Runtime 可解释的规则。

| 字段 | 说明 | MVP 约束 |
| --- | --- | --- |
| candidates | 候选轮次列表 | 按声明顺序稳定扫描 |
| actor_selector | 选择哪个参与者或哪类角色 | 结果必须能映射到唯一 actor；多 actor 时用 participant_order 串行化 |
| step_selector | 本轮候选 step 范围 | 只能引用 steps 中存在的 step |
| when | 候选轮次成立条件 | 使用 GuardExprV1，不成立则跳过 |
| priority | 同时成立时的顺序 | MVP 可使用声明顺序，priority 作为未来预留 |
| on_no_candidate | 无候选时如何处理 | MVP 支持 pause、end、error 三种策略 |

Scheduler 不直接决定 allowed steps。它只给出 candidate steps；每个 step 仍需要经过 StepContract.preconditions 过滤，才会进入 allowed steps。

### 6.8 GuardExprV1

Guard 是 Runtime 的条件判断语言，用于 preconditions、accept_when、terminal_rules 和 visibility_rules。

| 能力 | 说明 |
| --- | --- |
| 可读数据 | committed state、constants、当前 actor、最近事件摘要、提交 args |
| preconditions 可读范围 | 不可读取 args，因为此时还没有用户或 AI 输出 |
| accept_when 可读范围 | 可以读取 args，用于判断提交内容是否符合动作约束 |
| terminal_rules 可读范围 | 不可读取未提交输出，只能读取 committed state 和事件摘要 |
| visibility_rules 可读范围 | 读取 actor、state、event/resource 元数据，决定是否可见 |
| 运算能力 | 布尔组合、等值、大小比较、存在性、集合包含、计数 |
| 禁止能力 | 任意代码、网络调用、LLM 判断、非确定性时间函数 |

Guard 的目标不是成为通用编程语言，而是覆盖流程控制最常见的问题：阶段是否到达、轮次是否超限、某角色是否仍在场、某动作是否已经做过、某材料是否对当前 actor 可见。

### 6.9 StateEffectV1

StateEffect 是动作成功后的确定性状态变化。

| 能力 | 说明 |
| --- | --- |
| 可读数据 | 当前 committed state、constants、actor、accepted step、content、args |
| 可写范围 | 只能写 state_schema 声明过的 state 路径 |
| 最小操作 | set、increment、append、remove、clear |
| 输出结果 | state_patch，而不是直接覆盖整份 state |
| 校验时机 | 生成 patch 后、提交事件前，用 state_schema 校验结果状态 |
| 执行顺序 | 一个 step 多个 effect 按声明顺序执行 |
| 禁止能力 | 写 EventLog、写资源正文、调用 LLM、读取不可见上下文 |

Effect 的作用是让 Pattern 作者可以组合出更复杂的场景，而不需要 Runtime 为每个业务写特殊逻辑。例如“谁是卧底”的投票计数、出局名单、当前轮次，都应该由 state_effects 修改 state，再由 Scheduler、Guard、Visibility 在下一轮读取 state。

### 6.10 TerminalRuleV1

TerminalRule 决定会话是否结束。

| 字段 | 说明 |
| --- | --- |
| name | 结束规则名称，便于调试和复盘 |
| when | GuardExprV1 条件 |
| reason | 面向用户和复盘的结束原因 |
| result_status | ended、failed、cancelled 等会话结果 |

Terminal 检查有两个时机：

- tick 开始时检查：如果上一轮已经让会话结束，本轮不再调用 LLM。
- StepCommitted 后检查：如果本次动作导致结束条件成立，提交动作后立即把 session 标记为结束。

TerminalRule 不生成角色发言。如果场景需要“结束陈述”，应建模为一个普通 AI step，再由后续 TerminalRule 结束会话。

### 6.11 StepContract 如何驱动一次动作

一次动作从候选到提交分为六个阶段。

| 阶段 | 消费字段 | 结果 |
| --- | --- | --- |
| 候选生成 | scheduler、participants、participant_order、steps.actor | 得到当前 actor 和 candidate steps |
| 允许性判断 | steps.preconditions、constants、当前 state | 得到 allowed steps |
| 上下文投影 | visibility_rules、context_profile、events、resources、state | 得到当前 actor 的 visible context |
| Prompt 渲染 | 当前 actor、roles、participants、allowed steps、visible context | 得到本轮 AI 请求 |
| 输出校验 | selected_step、args_schema、args_ref_paths、accept_when | 判断 AI 或用户动作是否可接受 |
| 状态提交 | state_effects、state_schema、RuntimeEvent | 更新状态、写入事件、生成新 SessionView |

关键约束：

- preconditions 发生在模型调用前，用于决定 allowed steps。
- accept_when 发生在用户输入或 AI 输出后，用于校验 args 和当前状态。
- state_effects 只能在动作被接受后执行。
- Prompt 中出现的规则不是事实源，最终以 Runtime 校验结果为准。
- 用户普通发言不要求用户自己选择 selected_step；Runtime 按当前 allowed human step 包装用户输入。
- pause、retry、fork、end、withdraw 等系统控制行为不混入普通聊天，必须走 RuntimeCommand。

### 6.12 Runtime Tick 详细流程

每次 Runtime tick 表示系统尝试推进一次会话。tick 可以由前端请求触发，也可以由服务端在一次用户提交后继续触发 AI 轮次；MVP 推荐先显式暴露“提交用户输入”和“执行 AI 轮次”，便于调试和恢复。

| 顺序 | 步骤 | 输入 | 输出 |
| --- | --- | --- | --- |
| 1 | 读取当前状态 | session、branch、state_version | 当前 committed state |
| 2 | 检查结束条件 | terminal_rules、state | 已结束则返回 SessionView |
| 3 | 计算当前 actor | scheduler、participants、state | active actor |
| 4 | 计算 allowed steps | candidate steps、preconditions、constants、state | allowed step list |
| 5 | 计算可见事实 | visibility_rules、actor、state、events、resources | visible facts |
| 6 | 构建上下文 | context_profile、visible facts、budget | VisibleContextBundle |
| 7 | 渲染 Prompt | actor、role、allowed steps、VisibleContextBundle | LLM request 和 prompt_hash |
| 8 | 获得输入 | AI 输出、用户提交或系统动作 | candidate action |
| 9 | 校验动作 | selected_step、args_schema、accept_when、visible refs | accepted 或 rejected |
| 10 | 计算状态变化 | state_effects、current state、args | state_patch |
| 11 | 提交事件 | action、state_patch、hash、metadata | RuntimeEvent |
| 12 | 再次检查结束条件 | terminal_rules、latest state | session status |
| 13 | 生成视图 | latest state、visible transcript | SessionView |

失败分支：

| 失败类型 | 处理方式 |
| --- | --- |
| 模型调用失败 | 记录 StepAttemptFailed，不推进 state_version，允许有限重试 |
| 模型输出格式错误 | 尝试一次结构修复或重试；仍失败则记录 StepAttemptFailed |
| selected_step 不在 allowed steps | 拒绝提交，记录 StepAttemptFailed |
| args 不符合 args_schema | 拒绝提交，记录 StepAttemptFailed |
| 引用不可见资源 | 拒绝提交，记录 StepAttemptFailed |
| state_patch 校验失败 | 拒绝提交，记录 StepAttemptFailed，并视为场景定义缺陷 |
| state_version 冲突 | 拒绝当前提交，要求客户端刷新 SessionView 后重试 |

提交语义：

- 只有 accepted action 才能生成 StepCommitted。
- StepCommitted 与 state_patch 必须在同一事务中保存。
- result_state_version 必须等于 base_state_version 的下一版本。
- 重放会话时只应用 RuntimeEvent 中的 state_patch，不重新解释历史 state_effects。
- prompt_hash、visibility_hash、context_projection_hash 用于复现当时模型请求，不作为状态真相。

### 6.13 Runtime 子模块边界

| 子模块 | 输入 | 输出 | 不做什么 |
| --- | --- | --- | --- |
| Scenario Loader | ConfirmedScene | NormalizedScenarioV1 | 不生成新场景 |
| State Store | RuntimeEvent | 当前 state | 不解释 prompt |
| Scheduler | state、participants、steps | active actor、candidate steps | 不调用 LLM |
| Guard Evaluator | state、constants、actor、args | true 或 false | 不修改状态 |
| Visibility Projector | actor、events、state、resources | visible facts | 不生成摘要结论 |
| Context Manager | visible facts、context_profile | context package | 不绕过 visibility |
| Prompt Renderer | actor、role、allowed steps、context package | LLM request | 不调用 LLM |
| LLM Adapter | LLM request | model response | 不校验业务合法性 |
| Output Validator | model response、allowed steps、args_schema | accepted 或 rejected | 不推进状态 |
| Effect Applier | state_effects、accepted action | state patch | 不写事件 |
| Commit Service | accepted action、state patch | RuntimeEvent | 不重新生成内容 |
| View Projector | state、events、visibility | SessionView | 不自行推进流程 |

## 7. 可见性与上下文

### 7.1 可见性原则

不同角色可能看到不同信息。

例如：

- 面试官可以看到面试目标。
- 候选人只看到问题和公开材料。
- 谁是卧底中，每个玩家只能看到自己的词。
- 复盘者可以看到用于复盘的证据，但最终报告仍应面向用户可读。

可见性必须在上下文生成、角色发言和复盘中一致生效。

### 7.2 Visibility Projector

Visibility Projector 负责把全量事件、状态和资源投影成某个 actor 当前可见的事实集合。它是 Context Manager 和 Prompt Renderer 的上游。

| 输入 | 输出 | 说明 |
| --- | --- | --- |
| actor | 当前要生成视图或 prompt 的参与者 | 用户视图、AI prompt、复盘都必须声明 actor 或 review scope |
| events | 当前 branch 的事件流 | 只输出该 actor 可见的事件片段和引用 |
| state | committed state | 只输出规则允许暴露的 state slice |
| resources | 材料和资源 | 只输出可见资源的摘要、anchor 或正文片段 |
| visibility_rules | 可见性规则 | 默认拒绝，命中规则后才可见 |

Visibility Projector 不生成总结，也不补充业务判断。它只回答一个问题：某个 actor 在当前状态下能看到哪些事实。

### 7.3 VisibleContextBundle

Context Manager 在可见事实基础上，结合 context_profile 和 token budget，生成 VisibleContextBundle。Prompt Renderer 只能接收这个 bundle，不能接收全量事件流或全量 NormalizedScenarioV1。

| 字段 | 来源 | 用途 |
| --- | --- | --- |
| actor_id | Runtime 当前 actor | 标识本轮模型扮演对象 |
| role_prompt | roles 中当前 role 的稳定提示 | 提供长期目标和身份边界 |
| participant_prompt | participants 中当前 actor 的个体提示 | 提供个体风格和差异 |
| state_slice | visibility 过滤后的 state | 告诉模型当前进度 |
| event_slices | visibility 过滤并裁剪后的历史 | 提供必要对话上下文 |
| resource_slices | visibility 过滤后的材料片段 | 提供可引用材料 |
| allowed_steps | Runtime 计算后的 allowed steps | 约束模型本轮只能选这些动作 |
| output_requirements | selected_step、content、args 的输出要求 | 便于 Output Validator 校验 |
| source_refs | bundle 中内容的来源引用 | 支撑调试、复盘和证据追溯 |
| visibility_hash | 可见事实摘要 | 用于复现权限投影 |
| context_projection_hash | 上下文投影摘要 | 用于复现 prompt 输入 |

MVP 不做复杂长程压缩。若上下文过长，优先裁剪旧历史、保留最近关键轮次，并生成轻量摘要。未来 summary 必须绑定 source_refs、branch_id 和 visibility_hash，不能跨权限复用。

### 7.4 Schema 字段如何作用于 LLM Prompt

Prompt Renderer 是确定性模块，不是另一个 AI。它只把当前轮必要信息渲染给角色模型。

本轮 Prompt 应由以下层组成：

| 层 | 来源字段或数据 | 作用 |
| --- | --- | --- |
| 输出协议 | 固定 LLM 输出约束 | 要求模型返回 selected_step、content、args |
| 当前角色 | VisibleContextBundle.role_prompt、participant_prompt | 告诉模型当前扮演谁、目标和行为边界 |
| 当前状态摘要 | VisibleContextBundle.state_slice | 告诉模型当前进度 |
| 可见历史 | VisibleContextBundle.event_slices | 提供必要对话上下文 |
| 可见材料 | VisibleContextBundle.resource_slices | 提供可引用材料 |
| 当前 allowed steps | VisibleContextBundle.allowed_steps | 告诉模型本轮只能选择哪些动作 |
| 当前 step 参数要求 | StepContract.args_schema、args_ref_paths | 告诉模型 args 应如何填写 |
| 局部动作说明 | StepContract.prompt | 告诉模型每个 allowed step 的选择条件和发言要求 |

不应进入 Prompt 的内容：

- 全量 NormalizedScenarioV1。
- 未经过 Visibility Projector 的事件、状态和资源。
- 不可见材料。
- 不可见历史。
- 其他角色私密状态。
- 所有 steps 的完整列表。
- terminal_rules、state_effects、scheduler 内部规则。
- review_contract 的复盘规则。
- 原始 API Key、模型配置和本地存储路径。

### 7.5 Schema 到 Prompt 的映射规则

| Schema 字段 | Prompt 中的投影方式 |
| --- | --- |
| roles.prompt | 只注入当前 actor 对应 role 的提示 |
| participants.prompt | 只注入当前 actor 的个体提示 |
| state_schema、initial_state、current state | 不直接注入结构定义，只注入可见 state_slice |
| resources | 只注入当前 actor 可见且 context_profile 需要的片段 |
| steps.prompt | 只注入当前 allowed steps 的选择说明和动作说明 |
| args_schema | 转成当前 allowed steps 的参数填写要求 |
| args_ref_paths | 转成“可引用材料必须放在指定参数位置”的提示 |
| scheduler | 不直接展示给模型，只通过 allowed steps 体现 |
| visibility_rules | 不直接展示给模型，只决定哪些内容可进入 |
| context_profiles | 决定注入哪些历史、状态和材料 |
| terminal_rules | 不进入 Prompt |
| state_effects | 不进入 Prompt |
| review_contract | 不进入演练 Prompt，只进入复盘阶段 |

### 7.6 Prompt Renderer 的边界

Prompt Renderer 的输入：

| 输入 | 说明 |
| --- | --- |
| current actor | Runtime 已经计算出的当前 actor |
| VisibleContextBundle | Context Manager 已经生成的可见上下文 |
| allowed steps | Runtime 已经计算出的动作集合 |
| output contract | 输出结构和校验要求 |
| prompt profile | 固定 block 顺序和渲染策略 |

Prompt Renderer 的输出：

| 输出 | 说明 |
| --- | --- |
| prompt blocks | 稳定排序的 prompt 片段 |
| llm request | 发给模型的请求体摘要 |
| prompt_hash | prompt 内容摘要 |
| source_refs | 每个重要片段来自哪个 state、event 或 resource |

Prompt Renderer 不负责：

- 判断当前轮到谁。
- 自行过滤权限。
- 自行选择 step。
- 自行修改状态。
- 自行解释 terminal_rules。
- 根据模型输出推进会话。

### 7.7 Prompt Block Registry

为了避免重新变成手写大 Prompt，Prompt Renderer 应维护稳定的 block registry。

| Block | 内容来源 | 是否可缓存 | 说明 |
| --- | --- | --- | --- |
| output_protocol | 固定输出协议 | 是 | 变更频率最低 |
| role_identity | role_prompt、participant_prompt | 是 | 同一 actor 多轮通常稳定 |
| current_progress | state_slice | 否 | 随会话推进变化 |
| visible_history | event_slices | 否 | 随事件流变化 |
| visible_materials | resource_slices | 视材料是否变化 | 大材料未来可按 digest 缓存 |
| allowed_steps | allowed steps、StepContract.prompt | 否 | 每轮可能变化 |
| argument_requirements | args_schema、args_ref_paths | 否 | 跟 allowed steps 绑定 |

缓存命中率的关键不是把动态内容放到最后那么简单，而是让稳定 block 与动态 block 分离，并让每个 block 有独立 hash。这样角色身份、输出协议、固定材料可以复用，当前状态、历史和 allowed steps 单独变化。

### 7.8 避免重新变成手写大 Prompt

核心规则：

- Prompt 只表达“当前轮怎么生成”，不表达“系统真相”。
- 流程规则必须落在 scheduler、preconditions、accept_when、state_effects、terminal_rules 中。
- 权限规则必须落在 visibility_rules 中。
- 输出结构必须由 Output Validator 校验。
- 如果某条规则不被 Runtime 校验，它最多是软提示，不是系统规则。

### 7.9 Summary 预留

MVP 可以不把 summary 作为主链路，但数据结构需要允许未来引入。

未来 summary 必须满足：

- 绑定来源会话片段。
- 绑定可见性范围。
- 绑定分支。
- 不能跨权限范围复用。

## 8. 分支、撤回、重试

MVP 不提供完整分支、撤回和 fork 的 UI。

但底层记录必须避免静默覆盖，为后续框架能力预留。

### 8.1 MVP 支持范围

MVP 支持：

- 结束后重新开始一次新会话。
- AI 生成失败时重试当前模型调用。
- 手动暂停和继续。

MVP 不支持：

- 从任意历史节点创建分支。
- 撤回任意历史消息。
- 对比分支复盘。
- 可视化分支树。

### 8.2 预留原则

| 能力 | MVP 预留方式 |
| --- | --- |
| 重试 | 保留 attempt 概念，不覆盖旧失败记录 |
| 撤回 | 不删除历史，未来用新事件表达撤回后的可见视图 |
| fork | 保留 branch_id，MVP 固定主分支 |
| 分支复盘 | ReviewReport 绑定 session_id 和 branch_id |

### 8.3 RuntimeCommand 与 EventLog 语义

RuntimeCommand 是 UI 或系统发起的控制行为，不是用户普通发言。

| Command | MVP 支持 | 说明 |
| --- | --- | --- |
| pause | 是 | 暂停后 Runtime 不再自动推进 AI 轮次 |
| resume | 是 | 从当前 committed state 继续 |
| end | 是 | 用户手动结束会话 |
| retry_last_ai | 是 | 重试最近一次失败或不满意的 AI 轮次，MVP 可限制为未提交成功前重试 |
| withdraw | 否 | 未来用新事件改变可见投影，不删除旧事件 |
| fork | 否 | 未来从某个 event_id 创建新 branch_id |

EventLog 是会话事实源，SessionView 是投影结果。

- StepCommitted 表示动作已经被接受，必须可以重放。
- StepAttemptFailed 表示一次尝试失败，不能推进状态。
- RuntimeCommandCommitted 表示控制行为已经生效。
- MVP 固定主 branch_id，但事件字段必须保留 branch_id。
- 未来 fork 不复制历史事件，只从 base event 建立新 branch，Visibility Projector 计算当前 branch 可见事件。

## 9. 多真人参与

多真人参与不进入 MVP，也不作为近期开小口能力。

原因：

- 真人输入不可预测。
- 多人可能同时输入或长期不响应。
- 多人意图可能冲突。
- 流程需要处理超时、替补、跳过和恢复。
- 可见性和权限复杂度显著上升。
- 复盘需要区分不同真人责任和表现。

因此，多真人参与应作为更远版本的架构升级，届时需要重新设计会话控制、参与者身份、输入仲裁、可见性和协作体验。

## 10. 存储设计

MVP 采用本地持久化存储。

推荐存储对象：

| 对象 | 说明 |
| --- | --- |
| model_configs | 模型配置和连接状态 |
| scene_templates | 内置模板和版本 |
| scene_drafts | 用户草稿 |
| confirmed_scenes | 已确认场景 |
| sessions | 会话元信息 |
| runtime_events | 会话过程事件 |
| session_snapshots | 可选的会话视图快照 |
| review_reports | 复盘报告 |
| materials | 轻量材料 |

隐私要求：

- 本地保存默认开启。
- API Key 保存到 SQLite 的加密/隐藏字段，不接 macOS Keychain。
- API Key 不以明文重复展示，普通 API 响应、导出文件、调试面板和日志不得包含明文。
- 用户可以删除草稿、会话和复盘。
- 用户需要知道数据保存位置。

## 11. API 设计

API 只暴露产品级能力，不暴露内部执行细节。

### 11.1 模型配置

| 能力 | 说明 |
| --- | --- |
| 新增配置 | 保存模型供应商、地址和密钥 |
| 测试配置 | 检查模型是否可用 |
| 更新配置 | 修改名称、模型和地址 |
| 删除配置 | 删除本地配置 |

### 11.2 场景创建

| 能力 | 说明 |
| --- | --- |
| 创建草稿 | 从自然语言或模板创建 |
| 继续草稿 | 根据用户补充修改 |
| 获取预览 | 返回用户可读预览 |
| 检查草稿 | 返回可读问题和建议 |
| 确认场景 | 固定为可运行版本 |
| 导入导出 | 读取或保存场景文件 |

### 11.3 演练会话

| 能力 | 说明 |
| --- | --- |
| 启动会话 | 基于已确认场景创建会话 |
| 获取视图 | 返回 SessionView |
| 提交用户输入 | 推进当前用户动作 |
| 执行 AI 轮次 | 请求 AI 角色回应 |
| 暂停会话 | 暂停运行 |
| 继续会话 | 从暂停处继续 |
| 结束会话 | 手动结束 |

### 11.4 复盘

| 能力 | 说明 |
| --- | --- |
| 请求复盘 | 为会话生成复盘 |
| 获取复盘 | 查询报告 |
| 重试复盘 | 复盘失败后重试 |
| 查看历史 | 获取某会话的复盘列表 |

### 11.5 通用 API 语义

API 不暴露内部解释器细节，但必须暴露足够的并发和错误语义。

| 语义 | 要求 |
| --- | --- |
| 幂等 | 会创建事件或调用模型的接口需要 idempotency_key |
| 状态版本 | 提交用户输入、执行 AI 轮次、控制会话时携带 expected_state_version |
| 成功响应 | 返回最新 SessionView 或可查询的任务状态 |
| 可重试失败 | 模型超时、模型格式错误、网络错误应可重试，且不推进 state_version |
| 不可重试失败 | 场景定义非法、state_patch 校验失败、权限引用错误需要提示用户或进入调试 |
| 错误码 | 至少区分 validation_error、conflict、model_error、permission_error、scenario_error |
| 调试信息 | 默认给用户可读原因，高级面板可查看 prompt_hash、visibility_hash、event_id |

## 12. 前端页面

| 页面 | 说明 |
| --- | --- |
| 首页 | 新建场景、模板、最近草稿和最近会话 |
| 设置页 | 模型配置和连接测试 |
| 场景创建页 | 与场景助手对话，查看预览和检查结果 |
| 场景确认页 | 确认角色、流程、材料和复盘方式 |
| 演练页 | 对话、当前状态、用户动作、暂停和结束 |
| 复盘页 | 总结、维度评价、关键片段和建议 |
| 高级配置面板 | 查看和导入导出场景配置 |

前端原则：

- 普通用户优先看到预览和操作，不默认展示配置。
- 前端不自行判断当前轮到谁。
- 前端不自行判断场景是否结束。
- 前端不自行拼接 AI 上下文。

## 13. LLM 使用边界

### 13.1 LLM 用途

| 用途 | 说明 |
| --- | --- |
| 场景创建 | 根据用户需求生成或修改场景草稿 |
| 角色发言 | AI 角色在演练中发言 |
| 复盘生成 | 根据会话证据生成反馈 |

### 13.2 LLM 不负责

LLM 不直接负责：

- 判定当前轮到谁。
- 修改会话状态。
- 决定用户能看到哪些信息。
- 删除或覆盖历史。
- 绕过场景规则结束会话。

### 13.3 失败处理

| 失败 | 处理方式 |
| --- | --- |
| 模型不可用 | 提示用户检查配置，可重试 |
| 输出格式不符合要求 | 进行有限修复或重试 |
| 角色发言失败 | 保留当前会话状态，允许重试 |
| 复盘失败 | 保留会话记录，允许稍后重试 |

## 14. 测试策略

### 14.1 契约测试

覆盖：

- 场景草稿字段。
- 已确认场景字段。
- NormalizedScenarioV1 字段。
- StepContractV1 字段。
- RuntimeEvent 字段。
- SessionView 字段。
- ReviewReport 字段。

### 14.2 单元测试

覆盖：

- 场景检查。
- 模板参数展开。
- Scheduler 当前 actor 计算。
- GuardExpr 判断。
- StateEffect 生成 state_patch。
- TerminalRule 命中和未命中。
- 当前角色计算。
- 当前可选动作计算。
- 用户输入校验。
- AI 输出校验。
- 状态推进。
- 可见性过滤。
- Prompt Block 渲染和 hash 稳定性。

### 14.3 场景模拟测试

MVP 至少覆盖：

- 求职面试完整流程。
- 论文答辩 / 项目评审完整流程。
- 晋升 / 绩效沟通完整流程。
- AI 失败重试。
- selected_step 非法。
- args 非法。
- state_version 冲突。
- 暂停和继续。
- 手动结束。
- 复盘生成。

### 14.4 可见性测试

覆盖：

- 私密材料不进入无权限角色上下文。
- 不同角色看到不同对话视图。
- 复盘不会引用用户不可见证据。
- summary 未来启用时不能跨权限复用。

### 14.5 端到端测试

最小闭环：

1. 配置模型。
2. 从模板创建场景。
3. 确认场景。
4. 启动会话。
5. 完成一段演练。
6. 手动结束。
7. 生成复盘。

自动化测试默认应使用 Fake LLM。真实 LLM 测试作为手动 smoke。

### 14.6 Golden 测试与回放测试

Runtime 和 PromptRenderer 都需要稳定性测试。

| 测试 | 验收 |
| --- | --- |
| 场景 fixture 校验 | 求职面试、论文答辩 / 项目评审、晋升 / 绩效沟通至少各有一个手写 NormalizedScenarioV1 fixture |
| Runtime replay | 同一事件流重放后得到相同 state、SessionView 摘要和 terminal status |
| Prompt golden | 相同 VisibleContextBundle 渲染出相同 prompt blocks 和 prompt_hash |
| 可见性泄漏 | 无权限资源不能出现在 SessionView、VisibleContextBundle、prompt 调试记录中 |
| 失败不污染状态 | StepAttemptFailed 不改变 state_version，不影响下一轮 allowed steps |
| 导入导出 | 场景导出后重新导入，normalized hash 保持一致 |

## 15. MVP 开发切片

### Slice 1：技术骨架与测试基线

目标：

- 搭建 pnpm workspace、Web App、API Layer、packages、TypeScript、Vitest 和基础构建脚本。
- 建立契约测试、Runtime 单元测试和端到端测试入口。

验收：

- 应用可以启动。
- `pnpm test:run` 和 `pnpm typecheck` 可运行。
- 各 package 有最小导出，后续实现不需要重做项目结构。

### Slice 2：Runtime 契约与 Store Port

目标：

- 定义 NormalizedScenarioV1 的最小可运行子集。
- 定义 Scheduler、Guard、Effect、Terminal、Step、RuntimeEvent、SessionView 等运行契约。
- 定义 Runtime 依赖的 Store port，避免 Runtime 直接依赖 SQLite/Drizzle。

验收：

- Runtime 原语 schema 明确，且不包含 round、topic、vote、elimination 等垂直业务原语。
- Store port 不引用 SQLite、Drizzle、Fastify 或 React 类型。
- 核心事件、状态版本和错误码有契约测试保护。

### Slice 3：Smoke Fixture 与 Validator 骨架

目标：

- 手写一个极薄的求职面试 smoke fixture，作为 Runtime Core 的第一个输入。
- 实现 Scenario Validator 骨架，先覆盖阻塞性结构问题。
- 不在此阶段实现完整模板 Builder。

验收：

- smoke fixture 只包含 1 个用户、1 个 AI、用户 step、AI step、turn_count、scheduler、terminal rule 和 default context profile。
- smoke fixture 可通过 NormalizedScenarioV1 schema 和 Validator。
- 缺少 scheduler、terminal_rules、actor 或 context_profile 的场景被阻塞。

### Slice 4：Runtime Kernel、In-memory Store 与最小 Replay

目标：

- 用 smoke fixture 跑通确定性 Runtime。
- 先实现 in-memory Store adapter，验证 Runtime 只依赖 Store port。
- 实现最小 Replay，证明事件流是事实源。

验收：

- 启动写 SessionStarted。
- 合法动作写 StepCommitted 并推进 state_version。
- 非法动作写 StepAttemptFailed，不推进 state_version。
- 命中 terminal_rules 后 session 变 ended。
- Replay 只应用 StepCommitted 和 RuntimeCommandCommitted 的 state_patch，忽略 StepAttemptFailed。
- state_version 断层会被 replay 拒绝。

### Slice 5：Context 与 Visibility 内嵌 Runtime

目标：

- Runtime 调 AI 前完成可见性过滤和 VisibleContextBundle 构建。
- PromptRenderer 只接收 VisibleContextBundle 与 allowed steps。

验收：

- 私密材料不出现在无权限角色的 SessionView、VisibleContextBundle 和 prompt 调试记录中。
- 相同 bundle 渲染出稳定 prompt_hash。
- PromptRenderer 不接收全量 NormalizedScenarioV1、全量事件流或全量资源。

### Slice 6：Agent 协议与重试

目标：

- 接入真实 OpenAI 兼容接口。
- 支持结构化输出校验、有限重试和失败留痕。

验收：

- selected_step 非法、args 非法、模型超时都有明确处理。
- 失败不污染会话状态。
- 成功后事件可以追溯 prompt_hash 和 visibility_hash。

### Slice 7：SQLite/Drizzle Store Adapter

目标：

- 使用 SQLite + Drizzle 实现 Runtime Store port。
- 本地保存模型配置、草稿、确认场景、会话、事件和复盘。
- 保证事件提交和 state_version 更新的事务一致性。

验收：

- Runtime 可以在不改核心代码的情况下从 in-memory store 切换到 SQLite store。
- 成功提交事件才推进 state_version。
- API Key 不在普通列表接口或 UI 中明文回显。

### Slice 8：完整 Fixture、模板草稿与确认

目标：

- 补齐求职面试、论文答辩 / 项目评审、晋升 / 绩效沟通三个完整 NormalizedScenarioV1 fixture。
- 支持模板参数生成 UserSceneDraft。
- 支持场景预览、检查、确认为 ConfirmedScene、导入导出。

验收：

- 三个完整 fixture 可校验，并可被 Runtime 启动和至少推进一轮。
- 新增完整 fixture 不需要修改 Runtime 主流程。
- 默认值在预览中标注。
- 阻塞问题不能开始。
- 确认后草稿修改不影响已确认场景。
- 导入导出 roundtrip 后 normalized hash 稳定。

### Slice 9：Product API

目标：

- 暴露产品级 API，不暴露内部执行细节。
- 串起模板、草稿、确认场景、会话、AI 轮次、控制命令和复盘。

验收：

- 所有修改 session 的 API 携带 expected_state_version。
- 会创建事件或调用模型的 API 支持 idempotency_key。
- 错误码至少区分 validation_error、conflict、model_error、permission_error、scenario_error。

### Slice 10：复盘

目标：

- 会话结束后手动生成复盘。
- 复盘包含证据引用。

验收：

- 用户可以查看总结、维度评价、关键片段和建议。
- evidence_refs 能解析到 RuntimeEvent。
- 复盘失败可重试。

### Slice 11：Web MVP 页面流

目标：

- 用户可以通过页面完成“配置模型 -> 选择模板 -> 确认场景 -> 演练 -> 复盘”闭环。
- 普通页面展示产品概念，不暴露不必要的内部契约。
- 提供高级调试页查看 normalized_scenario、事件流、prompt/context hash。

验收：

- 新用户可以在 5 分钟内配置模型并运行一个模板场景。
- 普通用户完成一次演练不需要查看或编辑配置文件。
- 高级用户可以查看 normalized_scenario、事件流、prompt/context 摘要。

### Slice 12：E2E、Negative/Stress Fixture 与发布 Gate

目标：

- 用 Playwright 覆盖 MVP 最小闭环。
- 用 negative fixture 验证失败不污染状态。
- 用 stress fixture 验证 Runtime 原语表达力，但不扩大 MVP 产品范围。

验收：

- E2E 覆盖配置 Fake LLM、模板创建、确认场景、用户输入、AI 轮次、结束和生成复盘。
- 非法 selected_step、不可见资源引用、state_version 冲突都走失败路径。
- 谁是卧底 / 薪资谈判等 stress fixture 可以作为表达力测试，但不出现在 MVP 产品模板入口。
- `pnpm test:run`、`pnpm typecheck`、`pnpm build`、`pnpm e2e` 全部通过。

### Slice 13：Post-MVP 自然语言场景助手

目标：

- MVP 阶段不实现 Scene Assistant。
- Post-MVP 再让 Scene Assistant 辅助用户生成和修改草稿。
- AI 只生成草稿建议，不绕过 Builder 和 Validator。

验收：

- 最多追问 5 个关键问题。
- 输出必须经过同一 Validator。
- 用户不编辑高级配置也能得到可运行草稿。

## 16. 主要风险

### 16.1 场景创建质量不稳定

应对：

- 使用模板作为主入口。
- 场景助手只追问关键问题。
- 场景检查必须能阻止不可运行草稿。

### 16.2 AI 角色跑偏

应对：

- 每轮只给 AI 当前可选动作。
- 运行模块校验 AI 选择。
- 跑偏时允许重试。

### 16.3 复盘空泛

应对：

- 复盘要求引用会话证据。
- 不确定判断需要标注。
- MVP 先做基础复盘，不做复杂画像。

### 16.4 可见性泄漏

应对：

- 上下文生成必须先经过可见性过滤。
- 复盘也只能读取允许的证据。
- 加入可见性测试。

### 16.5 MVP 发散

应对：

- 不做多真人协作。
- 不做音视频。
- 不做模板市场。
- 不做复杂角色知识库。
- 不做完整分支可视化。

## 17. 版本路线

### MVP

- 本地模型配置。
- 模板创建。
- 先用求职面试 smoke fixture 跑通 Runtime Core，再补齐求职面试、论文答辩 / 项目评审、晋升 / 绩效沟通三个完整 NormalizedScenarioV1 fixture。
- 场景预览和检查。
- 单用户多 AI 角色演练。
- 手动复盘。
- 本地保存。

### V1.1

- 自然语言创建场景。
- 更好的场景导入导出。
- AI 回复重试体验。
- 更多模板。
- 更细的复盘维度。
- 轻量材料能力增强。

### V1.2

- 撤回最近一步。
- 从历史节点重新尝试。
- 基础分支记录。
- 分支复盘对比的基础能力。

### 更远期

- 多真人参与。
- 多人协作场景。
- 可视化流程编辑。
- 模板社区。
- 深度材料和角色知识库。

## 18. 原则符合性审查

当前方案总体符合前面讨论出的架构原则，但仍有少量需要在开发计划阶段继续收敛的工程细节。

| 原则 | 当前方案是否符合 | 证据 | 仍需注意 |
| --- | --- | --- | --- |
| PersonalFlow 是新项目，不迁移旧项目 | 符合 | 方案定位明确不描述旧项目迁移，不沿用旧命名 | 后续代码命名也要避免旧项目概念泄漏 |
| 奥卡姆剃刀，不随意新增概念 | 基本符合 | 核心对象收敛为 Draft、Template、ConfirmedScene、NormalizedScenario、Step、Event、SessionView、ReviewReport | Template 与 Pattern 的关系需要保持清晰，不能再引入隐藏中间协议 |
| Schema 是可执行事实源 | 符合 | NormalizedScenarioV1 是 Runtime 唯一解释的可执行场景定义 | 用户草稿和模板只是 authoring 入口，不能绕过 normalized_scenario |
| Pattern 是 shorthand/template，不是黑箱 | 符合 | SceneTemplate 需展开为完整 normalized_scenario，Runtime 不回头解释模板说明 | Pattern 新能力必须能展开成 Runtime 原语 |
| Runtime 是状态驱动解释器 | 符合 | Runtime Tick 从 committed state 计算 actor、allowed steps、visibility、terminal | 具体实现时不能把动态参与资格预展开成固定队列 |
| LLM 只选择 step 并生成内容 | 符合 | AI 输出协议限制为 selected_step、content、args，Runtime 校验后才提交 | 角色 LLM 不得直接修改 state、结束 session 或决定可见性 |
| 用户普通输入不需要 selected_step | 符合 | 用户普通发言由 Runtime 包装为当前 allowed human step | 系统控制行为必须走 RuntimeCommand，不混入聊天 |
| StepContract 是 step 语义事实源 | 符合 | StepContract 包含 prompt、args、preconditions、accept_when、state_effects、review_tags | Review、Role、Prompt 只能引用 StepContract 投影，不各自定义 step 语义 |
| Prompt Renderer 是确定性模块 | 符合 | Prompt Renderer 只接收 VisibleContextBundle 和 allowed steps，不接收全量 Schema | 不应新增 Prompt LLM 来决定提示词 |
| Context 先做可见性过滤 | 符合 | Visibility Projector 在 Context Manager 和 Prompt Renderer 之前 | 调试记录也不能泄漏不可见资源 |
| EventLog 追加保存，可重放 | 符合 | StepCommitted、StepAttemptFailed、RuntimeCommandCommitted 区分成功与失败，state_version 单调推进 | Snapshot 只能是派生缓存，重放以事件 state_patch 为准 |
| fork、withdraw、retry 是框架能力 | 基本符合 | 保留 branch_id、attempt、append-only 语义，MVP 不做完整 UI | V1.2 做撤回和分支时应继续避免删除历史 |
| Review 基于 evidence，不复用运行 prompt | 基本符合 | ReviewReport 绑定 evidence_refs，测试要求 evidence_refs 能解析到 RuntimeEvent | Evidence 聚类可后置，但证据引用不能缺失 |
| Runtime Kernel 不内置垂直业务原语 | 符合 | round、topic、vote、elimination 等由 State、Guard、Effect、Scheduler 表达 | Guard/Effect 操作集不能扩张成通用脚本语言 |
| 多真人参与放到远期 | 符合 | 多真人参与单独列为更远版本架构升级 | 当前只保证单真人 + 多 AI 角色 |
| materials、safety、knowledge_base 先做薄 | 符合 | 材料、隐私、安全均保留核心要求，不做复杂知识库 | 急救、医疗、法律等高风险训练需要更强 Safety 后再产品化 |

审查结论：

- 作为 MVP 技术方案，当前方向成立。
- 方案已经能指导 Runtime 主链路开发，不只是概念描述。
- 最大剩余风险不是架构方向，而是 Guard/Effect/Scheduler/Visibility 的最小 DSL 落地边界。
- 开发顺序必须保持“静态可执行场景 -> Runtime Core -> Context/Visibility -> Agent -> 自然语言创建”，否则容易把最难的 Runtime 闭环推迟。

## 19. 场景模拟测试覆盖

场景支持需要区分三层含义：

| 支持级别 | 含义 |
| --- | --- |
| MVP 必测 | 第一版就应该有 fixture 或端到端模拟，作为主链路验收 |
| 架构可表达 | Runtime 原语足以表达，可做压力测试 fixture，但不一定产品化 |
| 需要未来能力 | 核心原语方向不变，但依赖更强材料、知识库、安全、随机工具、多真人或长程记忆能力 |

### 19.1 MVP 必测场景

| 场景 | 是否支持模拟测试 | 主要覆盖点 | 需要的 Runtime 能力 |
| --- | --- | --- | --- |
| 求职面试 | 支持，且应作为 Runtime Core 首个 fixture | 动态追问、澄清、跳题、最大问题数、复盘证据 | adaptive_qa、pending_question、followup_count、allowed steps、evidence_refs |
| 论文答辩 / 项目评审 | 支持，作为第二个 fixture | 多评委顺序提问、材料引用、阶段结束、复盘维度 | Resource、Visibility、Scheduler、Step review_tags |
| 晋升 / 绩效沟通 | 支持，作为第三个 fixture | 职场沟通目标、争议事实、承诺事项、复盘证据 | participant/role prompt、simple scheduler、terminal_rules、evidence_refs |

这三个场景足以验证 MVP 的主链路：场景确认、启动会话、用户输入、AI step 选择、状态推进、可见上下文、结束和复盘。

### 19.2 架构可表达的压力测试场景

| 场景 | 支持判断 | 可验证的架构能力 | 不进入 MVP 的原因 |
| --- | --- | --- | --- |
| 谁是卧底 | 架构可表达 | 隐藏词、轮次、投票、淘汰、出局玩家不再参与 | 需要更复杂 UI 动作和游戏化体验 |
| 薪资谈判 | 架构可表达 | 私有底线、公开报价、教练私聊、报价历史 | 产品首期不聚焦谈判模板 |
| 晋升答辩 | 架构可表达 | 多评委、私密投票、材料证据、阶段推进 | 多评委可以串行模拟，但完整评审体验较重 |
| 绩效复盘 | 架构可表达 | 争议事实、承诺闭环、证据引用 | 需要更细 rubric 和组织语境 |
| 职场冲突沟通 | 架构可表达 | 情绪状态、调解插入、协议达成 | 情绪与安全边界需要更谨慎 |
| 客服投诉处理 | 架构可表达 | SOP 材料、情绪升级、升级条件、话术复盘 | 需要更完整材料和行业模板 |
| 销售话术训练 | 架构可表达 | 客户异议、信任度、隐藏评估、复盘建议 | 需要产品资料和 buyer persona 质量保障 |
| 英语口语陪练 | 架构可表达 | 学员回答、隐藏评分者、纠错、重试 | 需要语音能力时不属于文本 MVP |
| 代码评审训练 | 架构可表达 | diff 作为 Resource、finding 证据、review_tags | 需要代码材料解析和更强 evidence 检索 |

这些场景共同验证一个核心判断：Runtime 不需要内置 topic、vote、offer、affinity、finding 等业务原语；Pattern 可以用 State、Guard、Effect、Scheduler、Visibility 组合出来。自由角色扮演不进入 MVP，可在 Post-MVP 作为轻量文本互动场景重新评估。

### 19.3 需要未来能力的场景

| 场景 | 当前支持程度 | 缺口 |
| --- | --- | --- |
| 自由角色扮演 | 可做轻量文本模拟 | 需要更明确的场景目标、结束条件和复盘维度，适合 Post-MVP |
| 剧本杀 / 侦探解谜 | 可做轻量文本模拟 | 深度材料索引、私密线索管理、长程记忆、复杂结局判定 |
| TRPG / 文字冒险 | 可做简化模拟 | 随机数、工具调用、世界状态一致性、可重放随机事件 |
| 狼人杀简化版 | 可做单用户 + 多 AI 模拟 | 多真人实时参与、异步等待、夜间动作收集 UI |
| 恋综 / 社交模拟 | 可做小规模模拟 | 长程关系状态、私聊/公聊切换、角色记忆与隐私边界 |
| 急救 / 安全演练 | 可做结构化流程训练 | 高风险安全策略、危险动作拦截、权威知识库和免责声明 |

这些场景不是否定当前架构，而是说明 MVP 不应过早承诺完整产品体验。它们适合作为后续压力测试，验证 Runtime 原语是否仍然正交、是否需要扩展 Guard/Effect 操作集。

### 19.4 建议的模拟测试分层

| 测试层 | 场景 | 目的 |
| --- | --- | --- |
| Smoke fixture | 求职面试 | 每次改 Runtime 都跑，验证主链路不坏 |
| Contract fixture | 论文答辩 / 项目评审、晋升 / 绩效沟通 | 验证非面试场景不需要改 Runtime |
| Stress fixture | 谁是卧底、薪资谈判、晋升答辩 | 验证 State-driven Scheduler、Visibility 和 Effect 表达力 |
| Negative fixture | 非法 selected_step、不可见资源引用、state_version 冲突 | 验证失败不污染状态 |
| Future fixture | 剧本杀、TRPG、急救安全 | 标记依赖材料、工具、安全或多真人能力，不作为 MVP gate |

## 20. 实施前仍需定稿的事项

本文已经明确 Runtime、Prompt、核心契约和 MVP 技术栈方向，但进入开发前还需要把少量工程决策定死或在实施计划中细化。

| 事项 | 为什么需要定稿 | 推荐处理 |
| --- | --- | --- |
| 依赖版本与脚手架细节 | 影响项目初始化和 CI 命令 | 基于 TypeScript、pnpm workspace、React、Vite、Fastify、Zod、SQLite、Drizzle、Vitest、Playwright 制定实施计划 |
| 本地存储落地细节 | 影响事务、迁移和打包 | MVP 使用 SQLite + Drizzle ORM，不做多后端抽象 |
| API Key 保存方式 | 影响用户隐私和本地体验 | MVP 使用 SQLite 本地加密/隐藏字段，不使用 macOS Keychain；UI 明确本地保存风险且不明文回显 |
| Guard/Effect 最小操作集 | 影响 Pattern 能力边界 | 先覆盖 adaptive_qa、投票、阶段推进，不做通用脚本 |
| 内置模板 fixture | 影响验收是否可重复 | 先写极薄求职面试 smoke fixture 驱动 Runtime；Runtime 原语稳定后再补齐三个完整 NormalizedScenarioV1 fixture |
| Prompt golden 格式 | 影响 prompt 变更可审查性 | 只保存 block 摘要和 hash，避免默认暴露敏感全文 |
| Review evidence 策略 | 影响复盘可信度 | 先要求 evidence_refs 指向 RuntimeEvent，不做复杂证据聚类 |

这些事项不改变总体架构，但会影响第一版实现质量。开发计划应优先把它们拆成可验证的任务。

## 21. 结论

PersonalFlow 的 MVP 可以以模块化单体、本地存储、模板驱动和确定性会话运行作为技术基线。

当前最重要的工程取舍是：

- MVP 普通用户体验面向模板参数和场景预览；自然语言场景助手放到 Post-MVP。
- 运行时内部保留可执行场景定义。
- AI 只生成内容，不直接拥有流程控制。
- 会话记录追加保存，为复盘、重试、撤回和 fork 预留。
- 多真人参与放到更远版本。

这个方案可以支撑 MVP 快速落地，同时不堵住后续扩展到复杂角色扮演和个人化互动场景的路径。
