# PersonalFlow 开源发布与 Demo DB Spec

## 目标

用全新干净分支发布 PersonalFlow，并随包提供一份可直接浏览的 demo SQLite，让新用户在本地启动后立刻看到历史演练、复盘和场景样例，降低理解成本。

## 边界

- 不做专门发布 Skill；发布流程由仓库脚本和文档承载。
- 允许随包发布演练 SQL/SQLite，定位为本地优先产品的 demo artifact。
- demo DB 可以包含用于生成样例的加密临时模型 key，但发布门禁必须确认该 key 已在模型平台废弃且不可调用。
- 用户继续真实模型练习时，需要在设置页配置自己的 OpenAI-compatible key。

## 用户开箱路径

README 暴露一条主路径：

```bash
pnpm install
pnpm demo:start
```

`pnpm demo:start` 负责：

- 检查 Node.js 与 pnpm 版本。
- 创建缺失的 `.env`，默认使用 `PERSONALFLOW_MODEL_MODE=fake`。
- 如果 `.personalflow/personalflow.sqlite` 不存在，从 `examples/demo/personalflow-demo.sqlite` 复制 demo DB。
- 如果本地已有 DB，不覆盖用户数据，并提示可运行 `pnpm demo:reset` 恢复 demo。
- 启动 API 与 Web，输出 `http://127.0.0.1:5173`。

补充命令：

- `pnpm demo:reset`：删除本地 demo DB 并从随包 DB 重新复制。
- `pnpm demo:verify`：检查 API health、Web 可访问、demo 历史演练可读取。

## Demo 内容

随包 demo DB 至少包含 5 组已完成或接近完成的历史演练：

- 求职面试：后端工程师综合面试。
- 论文答辩：项目/论文答辩追问。
- B2B 销售：企业客户需求探索。
- 后端转正答辩：用户先开场，Leader 后追问。
- 辩论赛：短视频普及利弊。

每组演练需要包含场景、会话事件、关键材料、复盘报告和可见历史记录。内容允许由真实模型生成，但人物、公司、指标和材料必须是合成样例。

## 发布流程

维护者发布时执行仓库脚本，而不是 Skill：

1. 从当前确认可发布的工作树创建 orphan 干净分支。
2. 在干净分支上安装依赖并启动应用。
3. 配置专门的临时模型 key，跑真实演练 case，生成 demo DB。
4. 关闭应用，整理 SQLite，只发布单个 `examples/demo/personalflow-demo.sqlite`。
5. 在模型平台废弃该临时 key。
6. 用最终 demo DB 尝试触发真实模型调用，预期失败，确认 key 已不可用。
7. 在临时目录重新 clone 干净分支，运行 `pnpm install`、`pnpm demo:start`、`pnpm demo:verify`。
8. 对最终源码与 demo DB 做发布扫描后再推送公开仓库。

## 发布门禁

发布前必须满足：

- Git 历史为干净发布历史，不包含内部开发历史。
- 最终源码中没有 `.env`、本地路径、日志、构建产物、内部邮箱或内部平台标识。
- 最终发布物不包含 SQLite WAL/SHM 文件。
- demo DB 可以浏览历史演练，且不会覆盖用户已有本地 DB。
- demo DB 内的临时模型 key 已废弃，并通过调用失败验证。
- `pnpm demo:verify` 在全新 clone 中通过。
- 完整质量门禁 `pnpm release:gate` 在可执行测试的环境或 CI 中通过。

## 验收标准

一个从未接触项目的用户按 README 执行 `pnpm install && pnpm demo:start` 后，可以在浏览器中直接看到 demo 历史演练、复盘报告和场景模板；不配置自己的 key 也能理解核心产品体验；配置自己的 key 后可以继续创建真实模型演练。
