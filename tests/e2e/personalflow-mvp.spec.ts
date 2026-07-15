import { expect, test, type Page } from "@playwright/test";

const dummySecret = "dummy-e2e-api-key-not-real";

interface TemplateFlowCase {
  readonly title: string;
  readonly heading: string;
  readonly primaryLabel: string;
  readonly primaryValue: string;
  readonly expectedGoalLead: string;
  readonly expectedPreviewSnippets?: readonly string[];
  readonly expectedAiActorNames?: readonly string[];
  readonly initialUserInput?: string;
  readonly expectedInitialSnippet?: string;
  readonly userInput: string;
  readonly expectedUserSnippet: string;
}

const templateFlowCases: readonly TemplateFlowCase[] = [
  {
    title: "求职面试",
    heading: "求职面试 · 参数",
    primaryLabel: "目标岗位",
    primaryValue: "平台工程师",
    expectedGoalLead: "准备",
    expectedPreviewSnippets: ["后端面试官", "项目经历", "系统设计", "协作", "自然收尾"],
    expectedAiActorNames: ["后端面试官"],
    userInput: "I owned the launch and reduced operational risk with staged rollouts.",
    expectedUserSnippet: "I owned the launch"
  },
  {
    title: "论文答辩 / 项目评审",
    heading: "论文答辩 / 项目评审 · 参数",
    primaryLabel: "主题",
    primaryValue: "Runtime determinism audit",
    expectedGoalLead: "准备答辩",
    expectedPreviewSnippets: ["主评审", "方法评审", "开场", "证据", "风险", "收束"],
    expectedAiActorNames: ["主评审", "方法评审"],
    userInput: "The evidence is a deterministic replay trace with one stated limitation.",
    expectedUserSnippet: "deterministic replay trace"
  },
  {
    title: "后端转正答辩",
    heading: "后端转正答辩 · 参数",
    primaryLabel: "转正目标",
    primaryValue: "后端工程师转正",
    expectedGoalLead: "准备转正答辩",
    expectedPreviewSnippets: ["Leader", "后端同事", "QA", "PM", "合作前端"],
    expectedAiActorNames: ["Leader / 直属负责人"],
    initialUserInput: "I will open with platform delivery evidence, risks, and follow-up improvements.",
    expectedInitialSnippet: "platform delivery evidence",
    userInput: "I improved cross-team delivery quality through measurable platform guardrails.",
    expectedUserSnippet: "cross-team delivery quality"
  }
];

const expectNoSecretLeak = async (page: Page) => {
  await expect(page.locator("body")).not.toContainText(dummySecret);
  const domText = await page.locator("body").innerText();
  expect(domText).not.toContain(dummySecret);
};

const expectNoSecurityLeakInValue = (value: unknown) => {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(dummySecret);
  expect(serialized).not.toMatch(/api_key_(ciphertext|iv|tag)|authorization|bearer|ciphertext|provider raw|raw response|FULL PROMPT/i);
};

const expectNoInternalLeak = async (page: Page) => {
  await expect(page.locator("body")).not.toContainText(/NormalizedScenario|RuntimeEvent|prompt|storage row|provider|selected_step|step_id|allowed_steps|ai_backend_interviewer|ask_opening_1|answer_opening_1|open_interview_question|ask_technical_probe|ask_behavioral_probe|close_interview_summary|ask_interview_question|answer_interview_question|ask_panel_question|ask_impact_question|ask_calibration_probe|answer_calibration_probe|share_collaboration_growth_plan|chair_opening_question|method_evidence_probe|impact_risk_probe|respond_to_panel_question|chair_synthesis|session_[a-z0-9_-]+|\bv\d+\b|当前用户动作|允许动作/i);
};

const expectNoUnsupportedFutureCopy = async (page: Page) => {
  for (const word of ["综合评分", "雷达", "平均得分", "得分趋势", "本周目标", "导出全部", "清除全部数据", "Ollama", "MVP", "Debug"]) {
    await expect(page.getByText(word, { exact: false })).toHaveCount(0);
  }
};

const expectMainHeaderStatus = async (page: Page, expectedStatus: string) => {
  const status = page.locator("header [role='status']");
  await expect(status).toHaveText(expectedStatus);
  const statusText = await status.innerText();
  expect(statusText).not.toContain("session_");
  expect(statusText).not.toMatch(/\bv\d+\b/);
  expect(statusText).not.toMatch(/Session|state version|internal id/i);
};

const expectPrototypeSessionShell = async (page: Page) => {
  await expect(page.getByText("专注演练").first()).toBeVisible();
  await expect(page.locator(".session-topbar")).toBeVisible();
  await expect(page.locator(".session-input-dock")).toBeVisible();
  await expect(page.locator(".session-conversation")).toBeVisible();
  await expect(page.locator(".session-context-panel")).toBeVisible();
};

const ensureAiMessageVisible = async (
  page: Page,
  initialUserInput?: string,
  expectedInitialSnippet?: string
) => {
  if (initialUserInput !== undefined) {
    await page.getByRole("textbox").fill(initialUserInput);
    await page.getByRole("button", { name: "提交回答" }).click();
    if (expectedInitialSnippet !== undefined) {
      await expect(page.getByRole("region", { name: "演练对话" })).toContainText(expectedInitialSnippet);
    }
  }
  await expect(page.locator(".chat-message--ai .chat-bubble").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText("Simulated AI response.");
};

const completeTemplateMainFlow = async (page: import("@playwright/test").Page, flowCase: TemplateFlowCase) => {
  await page.getByRole("button", { name: "工作台" }).click();
  await expect(page.getByRole("heading", { name: "下午好，继续精进" })).toBeVisible();
  await expectNoUnsupportedFutureCopy(page);

  await page.getByRole("button", { name: "模板库" }).click();
  await expect(page.locator("h1.app-page-title")).toHaveText("模板库");
  await expect(page.locator("h2").filter({ hasText: "模板库" })).toBeVisible();
  await page.locator("article").filter({ hasText: flowCase.title }).getByRole("button", { name: "开始演练" }).click();
  await expect(page.getByRole("heading", { name: "完善演练简报" })).toBeVisible();
  await expect(page.getByRole("heading", { name: flowCase.title })).toBeVisible();
  await page.getByLabel(flowCase.primaryLabel).fill(flowCase.primaryValue);
  await page.getByRole("button", { name: "生成演练草稿" }).click();

  await expect(page.getByRole("region", { name: "场景预览" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "演练简报" })).toBeVisible();
  await expect(page.getByRole("region", { name: "场景预览" })).toContainText(flowCase.expectedGoalLead);
  await expect(page.getByRole("region", { name: "场景预览" })).toContainText(flowCase.primaryValue);
  for (const snippet of flowCase.expectedPreviewSnippets ?? []) {
    await expect(page.getByRole("region", { name: "场景预览" })).toContainText(snippet);
  }
  await expectNoInternalLeak(page);
  await page.getByRole("button", { name: "检查草稿" }).click();
  await expect(page.getByRole("region", { name: "场景检查结果" })).toContainText("场景检查通过");
  await page.getByRole("button", { name: "确认并开始演练" }).click();

  await expectPrototypeSessionShell(page);
  await expectMainHeaderStatus(page, "演练进行中");
  await expect(page.getByText("当前进度：演练进行中")).toBeVisible();
  await expect(page.getByRole("region", { name: "演练计时" })).toBeVisible();
  await expect(page.getByRole("region", { name: "版本历史" })).toBeVisible();
  await expect(page.locator(".session-input-dock__textarea")).toBeVisible();
  await expectNoUnsupportedFutureCopy(page);
  await expectNoInternalLeak(page);
  await ensureAiMessageVisible(page, flowCase.initialUserInput, flowCase.expectedInitialSnippet);
  await expectNoInternalLeak(page);

  await page.getByRole("textbox").fill(flowCase.userInput);
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText(flowCase.expectedUserSnippet);
  await expect(page.locator(".chat-message--user .chat-bubble").last()).toContainText(flowCase.expectedUserSnippet);
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText("Simulated AI response.");
  for (const actorName of flowCase.expectedAiActorNames ?? []) {
    await expect(page.getByRole("region", { name: "演练对话" })).toContainText(actorName);
  }
  await expectNoInternalLeak(page);

  if (flowCase.title === "求职面试") {
    await page.getByRole("button", { name: /撤回第 \d+ 轮并重写/ }).first().click();
    await expect(page.getByRole("region", { name: "撤回结果" }).getByRole("status")).toContainText("已创建一个新版本");
    await expect(page.getByRole("region", { name: "版本历史" })).toBeVisible();
    await expect(page.getByRole("region", { name: "版本历史" })).toContainText("撤回后重写");
    await expect(page.getByRole("region", { name: "演练对话" })).not.toContainText(flowCase.expectedUserSnippet);
    await page.getByRole("button", { name: "填回原回答" }).click();
    await expect(page.getByRole("textbox")).toHaveValue(flowCase.userInput);
    await page.getByRole("textbox").fill(`${flowCase.userInput} Updated branch answer.`);
    await page.getByRole("button", { name: "提交回答" }).click();
    await expect(page.getByRole("region", { name: "演练对话" })).toContainText("Updated branch answer");
    await expectNoInternalLeak(page);
  }

  await page.getByRole("button", { name: "结束演练" }).click();
  await expect(page.locator("h1.app-page-title")).toHaveText("复盘报告");
  await expect(page.getByText("复盘进度：复盘已生成")).toBeVisible();
  await expect(page.getByRole("heading", { name: "本轮总结" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "证据覆盖" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "本轮观察" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "关键片段" })).toBeVisible();
  await expect(page.locator("body")).toContainText(flowCase.expectedUserSnippet);
  await expect(page.locator("body")).not.toContainText("证据 1");
  await expect(page.getByRole("heading", { name: "可以更好的地方" })).toBeVisible();
  await expectNoUnsupportedFutureCopy(page);
  await expect(page.locator("body")).not.toContainText(/EVIDENCE_JSON_START|raw|provider|api_key|ciphertext|RuntimeEvent|prompt|event_|step_id|actor_id|ask_|answer_|chair_opening_question|method_evidence_probe|impact_risk_probe|respond_to_panel_question|chair_synthesis/i);
};

const expectNoImportExportLeak = async (page: Page) => {
  const productText = await page.locator("body").evaluate((body) => {
    const copy = body.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("textarea").forEach((node) => node.remove());
    return copy.innerText;
  });
  expect(productText).not.toMatch(/API Key|Authorization|Bearer|RuntimeEvent|review report|provider raw|debug metadata|storage row|session_[a-z0-9_-]+|state_version|step_id|action_id/i);
};

const createTemplateDraft = async (page: Page, flowCase: TemplateFlowCase, primaryValue: string) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "下午好，继续精进" })).toBeVisible();
  await page.getByRole("button", { name: "模板库" }).click();
  await expect(page.locator("h1.app-page-title")).toHaveText("模板库");
  await page.locator("article").filter({ hasText: flowCase.title }).getByRole("button", { name: "开始演练" }).click();
  await expect(page.getByRole("heading", { name: "完善演练简报" })).toBeVisible();
  await page.getByLabel(flowCase.primaryLabel).fill(primaryValue);
  await page.getByRole("button", { name: "生成演练草稿" }).click();
  await expect(page.getByRole("heading", { name: "演练简报" })).toBeVisible();
  await expectNoInternalLeak(page);
};

const completeCurrentPracticeAndReview = async (
  page: Page,
  userInput: string,
  expectedUserSnippet: string,
  initialUserInput?: string,
  expectedInitialSnippet?: string
) => {
  await page.getByRole("button", { name: "检查草稿" }).click();
  await expect(page.getByRole("region", { name: "场景检查结果" })).toContainText("场景检查通过");
  await page.getByRole("button", { name: "确认并开始演练" }).click();

  await expectPrototypeSessionShell(page);
  await ensureAiMessageVisible(page, initialUserInput, expectedInitialSnippet);
  await page.getByRole("textbox").fill(userInput);
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText(expectedUserSnippet);
  await expectNoInternalLeak(page);

  await page.getByRole("button", { name: "结束演练" }).click();
  await expect(page.locator("h1.app-page-title")).toHaveText("复盘报告");
  await expect(page.getByText("复盘进度：复盘已生成")).toBeVisible();
  await expect(page.getByRole("heading", { name: "本轮总结" })).toBeVisible();
  await expectNoUnsupportedFutureCopy(page);
  await expectNoInternalLeak(page);
};

test("内置模板主流程只通过 Web 入口使用 Fake LLM、临时 SQLite 和安全摘要", async ({ page }) => {
  const consoleLines: string[] = [];
  page.on("console", (message) => {
    consoleLines.push(message.text());
  });

  await page.goto("/");

  await page.getByLabel("系统导航").getByRole("button", { name: "设置" }).click();
  await expect(page.getByRole("heading", { name: "模型设置" })).toBeVisible();
  await expect(page.locator("body")).toContainText("PersonalFlow 优先使用本地数据");
  await expect(page.locator("body")).toContainText("当前支持 OpenAI 兼容服务");
  await expectNoUnsupportedFutureCopy(page);
  await expect(page.locator("body")).not.toContainText(/smoke|REAL_LLM_SMOKE/i);
  await page.getByLabel("访问密钥").fill(dummySecret);
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText("配置已保存，已自动设为当前默认模型。")).toBeVisible();
  await expect(page.getByRole("heading", { name: "当前默认模型" })).toBeVisible();
  const settingsText = await page.locator("body").innerText();
  expect(settingsText.indexOf("当前默认模型")).toBeLessThan(settingsText.indexOf("新增模型配置"));
  await expect(page.getByText("当前默认", { exact: true })).toBeVisible();
  await expect(page.getByText("已保存密钥")).toHaveCount(2);
  await expect(page.locator("body")).not.toContainText("masked / has_api_key");
  await expect(page.getByLabel("访问密钥")).toHaveValue("");
  await expectNoSecretLeak(page);
  const modelConfigs = await page.request.get("/api/model-configs");
  expect(modelConfigs.ok()).toBe(true);
  const modelConfigBody = await modelConfigs.json();
  expectNoSecurityLeakInValue(modelConfigBody);
  const modelConfigId = modelConfigBody.model_configs[0]?.id;
  expect(typeof modelConfigId).toBe("string");
  const modelConfigDetail = await page.request.get(`/api/model-configs/${modelConfigId}`);
  expect(modelConfigDetail.ok()).toBe(true);
  expectNoSecurityLeakInValue(await modelConfigDetail.json());

  await expect(page.getByRole("button", { name: "Debug" })).toHaveCount(0);

  await page.getByRole("button", { name: "工作台" }).click();
  await expect(page.getByRole("heading", { name: "下午好，继续精进" })).toBeVisible();
  await expect(page.getByText("本地演练工作室")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始一次演练" })).toBeVisible();
  await expect(page.getByRole("button", { name: "导入场景" })).toBeVisible();
  await expect(page.getByRole("button", { name: "模型设置" })).toBeVisible();
  await expectNoUnsupportedFutureCopy(page);
  await expect(page.getByRole("region", { name: "最近场景" })).toContainText("求职面试");
  await expect(page.getByLabel("本地概览")).toContainText("开始演练后会在这里继续。");
  await expect(page.getByLabel("本地概览")).toContainText("完成一次演练后会在这里看到复盘。");
  await expect(page.getByRole("heading", { name: "最近场景" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "求职面试" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "论文答辩 / 项目评审" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "后端转正答辩" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "辩论赛" })).toBeVisible();
  await expect(page.locator("article")).toHaveCount(4);
  await expect(page.locator("body")).not.toContainText(/谁是卧底|薪资谈判|undercover|salary negotiation/i);

  for (const flowCase of templateFlowCases) {
    await completeTemplateMainFlow(page, flowCase);
    await expectNoSecretLeak(page);
  }

  await page.getByRole("button", { name: "工作台" }).click();
  await expect(page.getByRole("heading", { name: "下午好，继续精进" })).toBeVisible();
  await expect(page.getByRole("region", { name: "最近场景" })).toContainText("求职面试");
  await expect(page.getByRole("region", { name: "最近场景" })).toContainText(/已结束|已完成|进行中|已暂停/);
  await expect(page.getByLabel("本地概览")).toContainText("复盘报告");
  await expect(page.locator("body")).not.toContainText(/session_[a-z0-9_-]+|state_version|step_id|action_id|actor_id|allowed_steps|RuntimeEvent|storage row|provider raw|raw prompt/i);

  await page.getByLabel("PersonalFlow 主导航").getByRole("button", { name: "复盘记录" }).click();
  await expect(page.locator(".review-archive-page")).toBeVisible();
  await expect(page.locator(".review-archive-card").first()).toBeVisible();
  await expect(page.locator("h1.app-page-title")).toHaveText("复盘记录");
  await expect(page.getByRole("button", { name: /查看 .*复盘/ }).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("请选择一条历史演练。");
  await expectNoUnsupportedFutureCopy(page);
  await expectNoInternalLeak(page);

  await page.getByRole("button", { name: "工作台" }).click();
  await page.getByRole("button", { name: "导入场景" }).click();
  await expect(page.getByRole("heading", { name: "场景导入导出", exact: true })).toBeVisible();
  await expect(page.getByText("这里导入导出的是单个场景文件，不是完整工作区备份。")).toBeVisible();
  await expectNoUnsupportedFutureCopy(page);
  await expectNoImportExportLeak(page);

  await page.getByRole("button", { name: "导出当前场景" }).click();
  await expect(page.getByLabel("导出的场景文件")).toHaveValue(/"normalized_hash"/);
  const exportText = await page.getByLabel("导出的场景文件").inputValue();
  expect(exportText).toContain('"normalized_hash"');
  expect(exportText).not.toMatch(/api_key|Authorization|Bearer|RuntimeEvent|review report|provider raw|debug metadata|storage row|session_/i);

  await page.getByLabel("粘贴场景文件").fill(exportText);
  await page.getByRole("button", { name: "导入场景" }).click();
  await expect(page.getByRole("heading", { name: "导入成功" })).toBeVisible();
  await expect(page.getByRole("button", { name: "进入场景确认" })).toBeVisible();
  await expectNoImportExportLeak(page);

  await page.getByRole("button", { name: "进入场景确认" }).click();
  await expect(page.getByRole("heading", { name: "演练简报" })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认并开始演练" })).toBeEnabled();
  await page.getByRole("button", { name: "确认并开始演练" }).click();
  await expectPrototypeSessionShell(page);
  await expectNoInternalLeak(page);

  await page.getByRole("button", { name: "退出演练" }).click();
  await expect(page.getByRole("heading", { name: "下午好，继续精进" })).toBeVisible();
  await page.getByRole("button", { name: "导入场景" }).click();
  await page.getByLabel("粘贴场景文件").fill(exportText.slice(0, -2));
  await page.getByRole("button", { name: "导入场景" }).click();
  await expect(page.getByText("JSON 格式不正确，请检查后重试。", { exact: true })).toBeVisible();
  await expectNoImportExportLeak(page);

  const tamperedExport = JSON.parse(exportText) as { normalized_hash: string };
  tamperedExport.normalized_hash = "0".repeat(tamperedExport.normalized_hash.length);
  await page.getByLabel("粘贴场景文件").fill(JSON.stringify(tamperedExport, null, 2));
  await page.getByRole("button", { name: "导入场景" }).click();
  await expect(page.getByText("场景文件校验失败，请重新导出后再导入。", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/Internal API operation failed|storage_error|normalized_hash mismatch|stack|ZodError/i);
  await expectNoImportExportLeak(page);

  await page.getByRole("button", { name: "工作台" }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "下午好，继续精进" })).toBeVisible();
  await expect(page.getByRole("region", { name: "最近场景" })).toContainText("求职面试");
  await expect(page.getByRole("region", { name: "最近场景" })).toContainText(/已结束|已完成|进行中|已暂停/);
  await expect(page.getByLabel("本地概览")).toContainText("复盘报告");
  await expect(page.locator("body")).not.toContainText(/session_[a-z0-9_-]+|state_version|step_id|action_id|actor_id|allowed_steps|RuntimeEvent|storage row|provider raw|raw prompt/i);

  await expect(page.getByRole("button", { name: "Debug" })).toHaveCount(0);
  expect(consoleLines.join("\n")).not.toContain(dummySecret);
});

test("P2 材料附加：用户保存材料后可在场景确认页附加并进入演练", async ({ page }) => {
  const materialBody = "项目目标是提升复盘质量，核心证据来自用户访谈和上线后的留存改善。";
  const temporaryBody = "本场临时正文用于提醒评审重点关注证据链、风险边界和后续行动，不应在预览中全文展示。";
  await page.goto("/");
  await page.getByRole("button", { name: "添加材料" }).click();
  await expect(page.getByRole("heading", { name: "我的材料" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存到材料库" })).toBeVisible();
  await page.getByLabel("材料名称").fill("答辩背景材料");
  await page.getByLabel("材料正文").fill(materialBody);
  await page.getByRole("button", { name: "保存到材料库" }).click();
  await expect(page.getByText("材料已保存，可在场景确认页引用。")).toBeVisible();
  await expect(page.getByRole("region", { name: "材料列表" })).toContainText("答辩背景材料");
  await expect(page.getByRole("region", { name: "材料列表" })).toContainText("可用于演练上下文");
  await expect(page.getByRole("region", { name: "材料列表" })).not.toContainText(materialBody);

  const flowCase = templateFlowCases[1];
  await createTemplateDraft(page, flowCase, "材料附加验收");
  const sceneMaterials = page.getByRole("region", { name: "场景材料" });
  const preview = page.getByRole("region", { name: "场景预览" });
  await expect(sceneMaterials).toContainText("引用材料库");
  await expect(sceneMaterials).toContainText("答辩背景材料");
  const libraryMaterial = sceneMaterials.getByRole("listitem").filter({ hasText: "答辩背景材料" });
  await libraryMaterial.getByRole("button", { name: "引用到当前场景" }).click();
  await expect(page.getByText("材料已附加到当前草稿。")).toBeVisible();
  await expect(libraryMaterial.getByRole("button", { name: "已引用" })).toBeDisabled();
  await expect(preview).toContainText("模板背景");
  await expect(preview).toContainText("已附加材料");
  await expect(preview).toContainText("答辩背景材料");
  await expect(preview).not.toContainText(materialBody);

  await expect(sceneMaterials.getByRole("heading", { name: "添加临时文本材料" })).toBeVisible();
  await sceneMaterials.getByLabel("临时材料标题").fill("本场临时重点");
  await sceneMaterials.getByLabel("临时材料正文").fill(temporaryBody);
  await sceneMaterials.getByRole("button", { name: "添加到当前场景" }).click();
  await expect(page.getByText("临时材料已添加到当前草稿。")).toBeVisible();
  await expect(preview).toContainText("本场临时重点");
  await expect(preview).not.toContainText(temporaryBody);

  await sceneMaterials.getByLabel("临时材料标题").fill("本场临时重点");
  await sceneMaterials.getByLabel("临时材料正文").fill(temporaryBody);
  await sceneMaterials.getByRole("button", { name: "添加到当前场景" }).click();
  const previewTextAfterDuplicate = await preview.innerText();
  expect((previewTextAfterDuplicate.match(/本场临时重点/g) ?? [])).toHaveLength(1);
  await expectNoInternalLeak(page);

  await page.getByRole("button", { name: "检查草稿" }).click();
  await expect(page.getByRole("region", { name: "场景检查结果" })).toContainText("场景检查通过");
  await page.getByRole("button", { name: "确认并开始演练" }).click();
  await expectPrototypeSessionShell(page);
  await expectNoInternalLeak(page);
});

test("P2 复盘重新练习：从已生成复盘创建一轮新的可互动演练", async ({ page }) => {
  const flowCase = templateFlowCases[0];
  await createTemplateDraft(page, flowCase, "Restart Practice Engineer");
  await completeCurrentPracticeAndReview(page, "I reduced outage risk with explicit rollout checkpoints.", "reduced outage risk");

  await page.getByRole("button", { name: "重新练习" }).click();
  await expect(page.getByText("已创建新的练习。")).toBeVisible();
  await expectPrototypeSessionShell(page);
  await expect(page.getByText("当前进度：演练进行中")).toBeVisible();
  await expect(page.getByRole("region", { name: "演练对话" })).not.toContainText("reduced outage risk");

  await expect(page.getByRole("region", { name: "演练对话" })).toContainText("Simulated AI response.");
  await page.getByRole("textbox").fill("In the new attempt I will lead with metrics and tradeoffs.");
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText("new attempt");
  await expectNoInternalLeak(page);
});

test("P2 场景管理历史复盘：用户可从我的场景打开历史复盘", async ({ page }) => {
  const flowCase = templateFlowCases[2];
  await createTemplateDraft(page, flowCase, "Principal Engineer");
  await completeCurrentPracticeAndReview(
    page,
    "I connected platform quality to adoption and incident reduction.",
    "incident reduction",
    flowCase.initialUserInput,
    flowCase.expectedInitialSnippet
  );

  await page.getByRole("button", { name: "我的场景" }).click();
  await expect(page.locator("h1.app-page-title")).toHaveText("我的场景");
  await expect(page.getByRole("region", { name: "已确认场景" })).toContainText("后端转正答辩");
  await expect(page.getByRole("region", { name: "历史复盘" })).toContainText("复盘已生成");
  await expect(page.getByRole("region", { name: "历史复盘" })).toContainText("后端转正答辩");
  await expectNoInternalLeak(page);

  await page.getByRole("region", { name: "场景档案" }).getByRole("button", { name: "查看演练详情" }).first().click();
  await expect(page.getByRole("heading", { name: "练习档案" })).toBeVisible();
  await expectNoUnsupportedFutureCopy(page);
  await expect(page.getByRole("region", { name: "关联复盘" })).toContainText("复盘已生成");
  await expectNoInternalLeak(page);

  await page.getByRole("region", { name: "关联复盘" }).getByRole("button", { name: "查看关联复盘" }).first().click();
  await expect(page.locator("h1.app-page-title")).toHaveText("复盘报告");
  await expectNoUnsupportedFutureCopy(page);
  await expect(page.getByText("复盘进度：复盘已生成")).toBeVisible();
  await expect(page.locator("body")).toContainText("incident reduction");
  await expect(page.locator("body")).not.toContainText(/session_[a-z0-9_-]+|review_[a-z0-9_-]+|scenario_[a-z0-9_-]+|state_version|step_id|action_id|actor_id|allowed_steps|RuntimeEvent|raw prompt/i);
});

test("UX-1 场景复制后进入副本确认页稳定保留复制成功提示", async ({ page }) => {
  const flowCase = templateFlowCases[0];
  await createTemplateDraft(page, flowCase, "Copied Scene Engineer");
  await page.getByRole("button", { name: "检查草稿" }).click();
  await expect(page.getByRole("region", { name: "场景检查结果" })).toContainText("场景检查通过");
  await page.getByRole("button", { name: "确认并开始演练" }).click();
  await expectPrototypeSessionShell(page);

  await page.getByRole("button", { name: "退出演练" }).click();
  await expect(page.getByRole("heading", { name: "下午好，继续精进" })).toBeVisible();
  await page.getByRole("button", { name: "我的场景" }).click();
  await expect(page.locator("h1.app-page-title")).toHaveText("我的场景");
  await page.getByRole("region", { name: "已确认场景" }).locator("li").filter({ hasText: "求职面试" }).first().getByRole("button", { name: "复制场景" }).click();

  await expect(page.getByRole("heading", { name: "演练简报" })).toBeVisible();
  await expect(page.getByRole("region", { name: "场景预览" })).toContainText("求职面试 的副本");
  await expect(page.getByRole("status")).toHaveText("场景副本已创建，可继续编辑草稿。");
  await expectNoInternalLeak(page);
});

test("复杂场景配置阶段会进入 Runtime 可见阶段展示", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("PersonalFlow 主导航").getByRole("button", { name: "我的场景" }).click();
  await expect(page.locator("h1.app-page-title")).toHaveText("我的场景");
  await page.getByRole("button", { name: "创建复杂场景" }).click();
  await expect(page.getByRole("heading", { name: "复杂场景配置" })).toBeVisible();
  await page.getByRole("button", { name: "生成场景草稿" }).click();
  await expect(page.getByRole("region", { name: "场景预览" })).toContainText("开场：确认目标和背景");
  await expect(page.getByRole("region", { name: "场景预览" })).toContainText("证据追问：连续追问指标证据和取舍");
  await page.getByRole("button", { name: "检查草稿" }).click();
  await expect(page.getByRole("region", { name: "场景检查结果" })).toContainText("场景检查通过");
  await page.getByRole("button", { name: "确认并开始演练" }).click();

  await expectPrototypeSessionShell(page);
  await expectMainHeaderStatus(page, "演练进行中");
  await expect(page.locator("body")).toContainText("当前阶段：开场");
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText("业务评审");
  await page.getByRole("textbox").fill("我会先说明目标、指标口径和当前证据，再解释风险控制计划。");
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.locator("body")).toContainText("当前阶段：证据追问");
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText("技术评审");
  await expectNoInternalLeak(page);
});

test("复杂模板运行时能力：后端转正答辩覆盖多 AI、多阶段、材料、复盘、重新练习和导入导出", async ({ page }) => {
  const flowCase = templateFlowCases[2];
  const firstAttemptSnippet = "platform adoption";
  const materialBody = "试用期内交付了跨团队平台治理，转正证据包括采用率、事故下降和协作反馈。";

  await page.goto("/");
  await page.getByRole("button", { name: "添加材料" }).click();
  await expect(page.getByRole("heading", { name: "我的材料" })).toBeVisible();
  await page.getByLabel("材料名称").fill("转正答辩材料");
  await page.getByLabel("材料正文").fill(materialBody);
  await page.getByRole("button", { name: "保存到材料库" }).click();
  await expect(page.getByText("材料已保存，可在场景确认页引用。")).toBeVisible();

  await createTemplateDraft(page, flowCase, "后端工程师转正");
  await expect(page.getByRole("region", { name: "场景预览" })).toContainText("Leader");
  await expect(page.getByRole("region", { name: "场景预览" })).toContainText("后端同事");
  await expect(page.getByRole("region", { name: "场景预览" })).toContainText("QA");
  await expect(page.getByRole("region", { name: "场景预览" })).toContainText("合作前端");
  const sceneMaterials = page.getByRole("region", { name: "场景材料" });
  await expect(sceneMaterials).toContainText("转正答辩材料");
  const promotionMaterial = sceneMaterials.getByRole("listitem").filter({ hasText: "转正答辩材料" });
  await promotionMaterial.getByRole("button", { name: "引用到当前场景" }).click();
  await expect(page.getByText("材料已附加到当前草稿。")).toBeVisible();
  await expect(promotionMaterial.getByRole("button", { name: "已引用" })).toBeDisabled();
  await expect(page.getByRole("region", { name: "场景预览" })).toContainText("转正答辩材料");
  await expect(page.getByRole("region", { name: "场景预览" })).toContainText("已附加材料");
  await expect(page.getByRole("region", { name: "场景预览" })).not.toContainText(materialBody);
  await expectNoInternalLeak(page);

  await page.getByRole("button", { name: "检查草稿" }).click();
  await expect(page.getByRole("region", { name: "场景检查结果" })).toContainText("场景检查通过");
  await page.getByRole("button", { name: "确认并开始演练" }).click();
  await expectPrototypeSessionShell(page);
  await expect(page.getByText("材料已附加到当前草稿。")).not.toBeVisible();
  await expect(page.locator("body")).not.toContainText(materialBody);
  await expect(page.locator("body")).toContainText("当前阶段：答辩人开场陈述");
  await expect(page.locator("body")).toContainText("当前发言者：答辩人：后端工程师");
  await expect(page.locator("body")).toContainText("请在输入框回应当前问题或提示。");
  await page.getByRole("textbox").fill("I will open with platform adoption evidence, risks, and follow-up improvements.");
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText("platform adoption evidence");
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText("Leader / 直属负责人");
  await expect(page.locator("body")).toContainText("当前阶段：Leader 追问");
  await page.getByRole("textbox").fill("I grew platform adoption by making rollout quality visible to partner teams.");
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText(firstAttemptSnippet);
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText("Leader / 直属负责人");
  await expect(page.locator("body")).toContainText("当前阶段：Leader 追问");
  await expectNoInternalLeak(page);

  await page.getByRole("button", { name: "结束演练" }).click();
  await expect(page.locator("h1.app-page-title")).toHaveText("复盘报告");
  await expect(page.getByText("复盘进度：复盘已生成")).toBeVisible();
  await expect(page.getByRole("heading", { name: "本轮总结" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "本轮观察" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "关键片段" })).toBeVisible();
  await expect(page.locator("body")).toContainText(firstAttemptSnippet);
  await expect(page.getByRole("heading", { name: "可以更好的地方" })).toBeVisible();
  await expectNoUnsupportedFutureCopy(page);
  await expectNoInternalLeak(page);

  await page.getByRole("button", { name: "重新练习" }).click();
  await expect(page.getByText("已创建新的练习。")).toBeVisible();
  await expectPrototypeSessionShell(page);
  await expectMainHeaderStatus(page, "演练进行中");
  await expect(page.getByRole("region", { name: "演练对话" })).not.toContainText(firstAttemptSnippet);
  await expect(page.locator("body")).toContainText("当前阶段：答辩人开场陈述");
  await page.getByRole("textbox").fill("In the new attempt I will first open with adoption metrics and calibration risks.");
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText("Leader / 直属负责人");
  await page.getByRole("textbox").fill("In the new attempt I will answer the leader with adoption metrics and calibration risks.");
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText("new attempt");
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText("Leader / 直属负责人");

  await page.getByRole("button", { name: "退出演练" }).click();
  await expect(page.getByRole("heading", { name: "下午好，继续精进" })).toBeVisible();
  await page.getByRole("button", { name: "导入场景" }).click();
  await page.getByRole("button", { name: "导出当前场景" }).click();
  await expect(page.getByLabel("导出的场景文件")).toHaveValue(/"normalized_hash"/);
  const exportText = await page.getByLabel("导出的场景文件").inputValue();
  expect(exportText).toContain('"normalized_hash"');
  expect(exportText).not.toMatch(/api_key|Authorization|Bearer|RuntimeEvent|review report|provider raw|debug metadata|storage row|session_/i);
  await page.getByLabel("粘贴场景文件").fill(exportText);
  await page.getByRole("button", { name: "导入场景" }).click();
  await expect(page.getByRole("heading", { name: "导入成功" })).toBeVisible();
  await page.getByRole("button", { name: "进入场景确认" }).click();
  await expect(page.getByRole("heading", { name: "演练简报" })).toBeVisible();
  await expect(page.getByRole("region", { name: "场景预览" })).toContainText("后端转正答辩");
  await expectNoInternalLeak(page);
});

test("论文答辩默认路径会让落地评审实际出场", async ({ page }) => {
  const flowCase = templateFlowCases[1];
  await createTemplateDraft(page, flowCase, "Runtime rollout readiness");
  await page.getByRole("button", { name: "检查草稿" }).click();
  await expect(page.getByRole("region", { name: "场景检查结果" })).toContainText("场景检查通过");
  await page.getByRole("button", { name: "确认并开始演练" }).click();

  await expectPrototypeSessionShell(page);
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText("主评审");
  await page.getByRole("textbox").fill("My claim is supported by replay evidence and I can explain the first limitation.");
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText("方法评审");

  await page.getByRole("textbox").fill("The method covers deterministic replay, with rollout risk handled by staged validation.");
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText("落地评审");
  await expect(page.locator("body")).toContainText("当前发言者：答辩人");
  await expect(page.locator("body")).toContainText("请在输入框回应当前问题或提示。");
  await expectNoInternalLeak(page);
});

test("求职面试默认路径保持单一后端面试官连续追问", async ({ page }) => {
  const flowCase = templateFlowCases[0];
  await createTemplateDraft(page, flowCase, "平台工程师");
  await page.getByRole("button", { name: "检查草稿" }).click();
  await expect(page.getByRole("region", { name: "场景检查结果" })).toContainText("场景检查通过");
  await page.getByRole("button", { name: "确认并开始演练" }).click();

  await expectPrototypeSessionShell(page);
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText("后端面试官");
  await page.getByRole("textbox").fill("I led a staged migration and measured reliability before full rollout.");
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByRole("region", { name: "演练对话" })).toContainText("后端面试官");
  await expect(page.locator("body")).toContainText("当前阶段：开场和自我介绍");
  await expect(page.locator("body")).toContainText("当前发言者：候选人");
  await expect(page.locator("body")).toContainText("请在输入框回应当前问题或提示。");
  await expectNoInternalLeak(page);
});
