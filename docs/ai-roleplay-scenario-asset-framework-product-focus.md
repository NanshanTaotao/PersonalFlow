# AI Roleplay 场景资产框架：产品重心

## 核心结论

我们要做的不是一个普通的 AI 陪练产品，而是一个 **AI 沟通场景资产框架**。

长期目标是成为 **AI Roleplay 场景工程化的开源标准**。因此，产品重心不应放在“做一个好用的陪练界面”，而应放在“定义、运行、评估、测试、版本化和复用沟通场景资产”。

一句话定义：

> 让 AI Roleplay 场景从散装 Prompt，变成可声明、可运行、可评估、可测试、可分发的工程资产。

## 产品定位

这个项目不应被定义为：

- AI 陪练 SaaS
- Prompt 管理工具
- 知识库问答工具
- 普通 Workflow 编排器
- 行业培训内容平台

更准确的定位是：

- AI 沟通场景资产框架
- Roleplay Scenario Engineering Framework
- 面向多轮沟通演练的场景协议、运行时和评估体系

第一性问题不是“用户如何练习”，而是：

> 一个沟通场景如何被标准化表达？

## 核心资产：Scenario Package

产品应围绕 `Scenario Package` 展开。

它是整个框架的核心资产单位，类似电商语境中的 SKU，但它不是单个 Prompt，而是一组结构化、可运行、可评估、可版本化的场景资产。

一个 `Scenario Package` 应包含：

```text
Scenario Package
├── workflow        # 沟通流程
├── persona         # 角色设定
├── knowledge       # 知识绑定
├── rubric          # 评估标准
├── evaluator       # 评估策略
├── constraints     # 合规、边界、禁区
├── examples        # 样例对话
├── tests           # 场景测试用例
└── metadata        # 版本、作者、适用行业、难度
```

如果 `Scenario Package` 定义不清，后续的 CLI、Web UI、PaaS、场景市场都会失去稳定基础。

## 产品重心排序

| 优先级 | 重心 | 说明 |
|---|---|---|
| P0 | Scenario Spec | 决定项目是否能成为标准，而不仅是工具 |
| P0 | Runtime | 证明 Spec 不是纸面协议，而是可以运行 |
| P0 | Evaluation Protocol | Roleplay 的价值不在对话本身，而在可评估、可训练 |
| P1 | Testing Harness | 让 Prompt、知识库、Rubric 的变化可回归验证 |
| P1 | Trace & Observability | 让场景行为、评分依据、知识引用可解释 |
| P1 | Versioning | 支持 Prompt、知识库、Rubric、场景流程持续演进 |
| P2 | Web UI | 有助于展示和使用，但不应早期喧宾夺主 |
| P2 | Hosted PaaS | 等开源标准被采用后再做托管服务 |
| P2 | Scenario Marketplace | 等生态中有人生产场景后再做市场 |

一句话：

> 先做标准和运行时，再做平台；先做开发者可信，再做终端体验。

## 第一重心：Scenario Spec

`Scenario Spec` 是整个项目的标准入口。

它需要定义一套 DSL 或配置协议，让开发者、培训顾问、行业专家可以声明一个 AI Roleplay 场景。

示例：

```yaml
id: sales_objection_handling_basic
type: roleplay
domain: sales
difficulty: beginner

workflow:
  - node: opening
  - node: discovery
  - node: objection
  - node: closing

persona:
  role: skeptical_buyer
  mood: cautious
  objection_style: price_sensitive

knowledge:
  - ./knowledge/product.md
  - ./knowledge/pricing.md

rubric:
  - active_listening
  - value_framing
  - objection_handling
  - closing_clarity
```

这个 Spec 的关键不是复杂，而是清晰、稳定、可扩展。

未来别人是否采用这个项目，首先取决于 `Scenario Spec` 是否能准确表达一个沟通场景。

## 第二重心：Runtime

只有 Spec 不够，必须有一个最小 Runtime 证明它能运行。

Runtime 的职责不是做复杂 UI，而是完成以下闭环：

```text
读取 Scenario Package
初始化角色 Persona
加载知识和约束
驱动多轮对话
记录 Session Trace
输出 Transcript
触发 Evaluator
生成 Feedback
```

早期 Runtime 可以优先做 CLI，不必一开始做 Web 产品。

示例命令：

```bash
roleplay run ./scenarios/sales_objection
roleplay eval ./sessions/session_001.json
roleplay replay ./sessions/session_001.json
```

CLI 对开源项目很重要，因为它降低理解成本，也便于开发者集成到自己的系统中。

## 第三重心：Evaluation Protocol

AI Roleplay 的价值不只是“对话像不像”，而是：

```text
用户在这个沟通任务中表现如何？
哪里做对了？
哪里没做到？
为什么扣分？
下次应该练什么？
```

因此，`Rubric` 必须是一等公民，而不是附属 Prompt。

评估体系建议拆成三层：

| 层级 | 作用 |
|---|---|
| Objective | 定义本次演练要达成什么目标 |
| Rubric | 定义如何判断表现好坏 |
| Evidence | 从对话中提取证据支撑评分 |

一个理想的评估结果应具备结构化、可解释、可复核的特点：

```json
{
  "score": 72,
  "dimensions": [
    {
      "name": "active_listening",
      "score": 80,
      "evidence": "用户复述了客户对价格的担忧",
      "suggestion": "可以进一步确认客户预算范围"
    },
    {
      "name": "value_framing",
      "score": 60,
      "evidence": "用户解释了功能，但没有绑定客户业务收益",
      "suggestion": "将产品能力转译为成本节省或风险降低"
    }
  ]
}
```

这会让框架从“能聊”升级为“能训练”。

## 第四重心：Testing Harness

如果目标是开源标准，`test` 能力非常关键。

Prompt、知识库、Rubric 都会漂移。场景作者需要能够回答：

```text
这个角色是否稳定？
这个 Rubric 是否前后一致？
知识库变更是否影响评分？
模型切换后场景是否仍然可用？
Prompt 修改有没有破坏原有行为？
```

因此需要提供类似以下能力：

```bash
roleplay test ./scenario
roleplay benchmark ./scenario --model gpt-4o
roleplay diff ./scenario@v1 ./scenario@v2
```

大多数 Prompt 工具只关心“运行”，而这个框架应关心“场景质量是否可回归”。

这是项目区别于普通 Prompt 工具和普通 Workflow 工具的关键。

## 第五重心：Trace & Observability

Trace 是调试、评估、治理的基础。

一次 Session 不应只保存 Transcript，还应保存：

```text
命中的 workflow 节点
每轮使用的 persona state
引用了哪些知识片段
触发了哪些约束
评估器引用了哪些证据
每个评分维度的依据
模型输入输出快照
```

Trace 的价值在于让场景作者能调试：

```text
为什么角色没有提出预期异议？
为什么评分偏高？
为什么知识没有被引用？
为什么用户明明完成任务却被扣分？
```

没有 Trace，Roleplay 场景调优会变成玄学。

## 早期不应成为重心的方向

早期不建议把资源集中在以下方向：

| 方向 | 原因 |
|---|---|
| 精美 Web UI | 容易变成普通 SaaS，稀释标准价值 |
| 大量行业模板 | 内容生产太重，个人不可持续 |
| 企业后台 | 没有标准采用前，后台价值有限 |
| 复杂权限系统 | 这是 PaaS 阶段的事 |
| 多模型适配过早铺开 | 先保证抽象正确，再做适配 |
| 场景市场 | 没有场景生产者之前，市场是空壳 |

早期产品应该更像 `LangGraph`、`OpenAPI Spec`、`dbt`、`Playwright` 这类偏工程标准与运行工具的项目，而不是一个培训 SaaS。

## 最小产品形态

MVP 应聚焦四件事：

```text
1. 定义 Scenario Package 规范
2. 提供 CLI Runtime 跑通演练
3. 提供 Rubric Evaluator 输出评分
4. 提供 scenario test 做质量回归
```

最小用户路径：

```text
开发者 clone 项目
查看 examples/
修改一个 scenario.yaml
运行 roleplay run
得到一次 transcript
运行 roleplay eval
得到结构化评分
运行 roleplay test
验证场景稳定性
```

这条链路跑通，项目就具备了开源标准的雏形。

## 产品北极星

产品北极星不应是 DAU、对话次数或模板数量。

更适合的北极星是：

> 一个高质量 Roleplay 场景从创建、运行、评估到复用的工程化程度。

早期可观察的指标包括：

| 指标 | 含义 |
|---|---|
| Scenario packages created | 有多少结构化场景被定义 |
| Scenario test pass rate | 场景是否稳定 |
| Rubric consistency | 评估是否前后一致 |
| Time to first scenario | 新用户多久能创建第一个场景 |
| Scenario portability | 同一场景能否跨模型运行 |
| Trace explainability | 评分和行为是否可解释 |

这些指标更符合“工程化标准”的定位。

## 最终结论

产品重心应是：

```text
以 Scenario Package 为核心资产
以 Scenario Spec 为标准入口
以 Runtime 证明可运行
以 Evaluation Protocol 证明可训练
以 Test Harness 证明可工程化
以 Trace 证明可治理
```

最重要的判断是：

> 我们不是在做 AI Roleplay 的前台产品，而是在定义 AI Roleplay 的工程资产层。

如果这个资产层成立，后续 Web UI、PaaS、企业版、场景市场都会自然长出来。

如果这个资产层不成立，越早做商业化界面，越容易变成一个没有壁垒的 AI 陪练壳。
