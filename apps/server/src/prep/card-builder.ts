import { createHash } from "node:crypto";
import { TeachingCardSchema, type KnowledgeType, type TeachingCard } from "@elenchi/shared";
import type { PreparedKnowledge } from "./knowledge-preparation.js";

export interface CardBuildInput {
  version: string;
  lessonId: string;
  source: string;
  rulesVersion: string;
  learnerVersion: string;
  objective: string;
  knowledge: Array<PreparedKnowledge & { id: string }>;
}

const typeToRequirement: Record<KnowledgeType, { kind: TeachingCard["requirements"][number]["kind"]; criterion: string }> = {
  fact: { kind: "recall", criterion: "独立回忆事实，并在必要时区分混淆项" },
  concept: { kind: "boundary", criterion: "解释关键属性，并判断正例与边界" },
  classification: { kind: "classification", criterion: "应用分类标准并解释归类依据" },
  relation: { kind: "application", criterion: "说明条件与关系，并在新情境中运用" },
  mechanism: { kind: "causal_reasoning", criterion: "解释因果链与必要条件" },
  formula: { kind: "calculation", criterion: "说明变量和适用域，正确设式并解释结果" },
  model: { kind: "representation", criterion: "完成表征转换并说明模型假设或局限" },
  procedure: { kind: "execution", criterion: "在变化任务中执行步骤并说明终止条件" },
  strategy: { kind: "decision", criterion: "根据目标、约束和代价作出选择并说明理由" },
  proof: { kind: "proof", criterion: "给出有效推理链并识别关键前提" },
  evaluation: { kind: "evaluation", criterion: "区分观察与推断，评价证据可靠性" },
  normative: { kind: "justification", criterion: "区分事实、规则与价值并提出有依据判断" },
};
const questionLead: Record<KnowledgeType, string> = {
  fact: "请不看教材回忆：", concept: "这个概念的边界在哪里？请解释并举一个反例：",
  classification: "按什么标准分类？请把一个新例子归类并说明理由：", relation: "在条件改变时关系会怎样？请用新情境说明：",
  mechanism: "中间经过哪些机制？请说明必要条件：", formula: "每个量和适用条件是什么？请设式并解释结果：",
  model: "现实如何映射到这个模型？它忽略了什么？", procedure: "请在变化后的情境中执行步骤，并说明何时停止：",
  strategy: "在当前目标和约束下你会怎么选？为什么？", proof: "结论如何从前提推出？请给出推理链：",
  evaluation: "证据支持到什么程度？还缺什么？", normative: "适用什么规则？请区分事实、规则和价值依据：",
};
function hash(source: string): string { return createHash("sha256").update(source).digest("hex"); }

/** Pure, deterministic bridge from prepared knowledge to an inspectable teaching card. */
export function buildTeachingCard(input: CardBuildInput): TeachingCard {
  if (input.knowledge.some((kp) => kp.evidence.some((quote) => !input.source.includes(quote)))) {
    throw new Error("card_evidence_not_grounded");
  }
  const knowledge = input.knowledge.map((kp) => ({
    id: kp.id, statement: kp.statement, type: kp.type, evidence: kp.evidence,
    conditions: kp.conditions, exceptions: kp.exceptions,
  }));
  const requirements = knowledge.map((kp) => {
    const policy = typeToRequirement[kp.type];
    return { id: `requirement:${kp.id}`, kpId: kp.id, kind: policy.kind,
      criterion: policy.criterion, independent: kp.type !== "fact" };
  });
  const tasks = knowledge.map((kp) => {
    const policy = typeToRequirement[kp.type];
    return { id: `task:${kp.id}`, requirementIds: [`requirement:${kp.id}`],
      question: `${questionLead[kp.type]}${kp.statement}`, rubric: policy.criterion,
      acceptableVariants: [], hints: ["先指出相关条件或关键关系", "用一个具体例子检验你的判断"] };
  });
  return TeachingCardSchema.parse({ version: input.version, lessonId: input.lessonId,
    sourceHash: hash(input.source), rulesVersion: input.rulesVersion, learnerVersion: input.learnerVersion,
    objective: input.objective, knowledge, requirements, tasks });
}
