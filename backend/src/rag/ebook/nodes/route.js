import { RouteSchema } from "../schemas.js";
import { updateExecution } from "../services/execution.js";
import { planItemForOriginalQuestion } from "../services/planning.js";

export function createRouteNodes({ model, bookName }) {
  const routeQuestionNode = async (state) => {
    const startedAt = Date.now();
    const router = model.withStructuredOutput(RouteSchema);
    const route = await router.invoke(`
你是问答路由器。请区分“是否需要书中证据”和“是否真的需要多跳拆解”，只能选择一种 mode：
- direct：寒暄、普通常识、无需《${bookName}》具体内容即可回答。
- single_retrieval：需要书中情节、人物、动机、地点、原文等证据，但一个完整检索问题通常即可回答。单一事件的“为什么”默认属于此类。
- multi_hop：答案确实依赖两个及以上先后事实、关系链、跨人物比较或必须先确认中间实体再继续检索。

不得仅因为问题需要查书就选择 multi_hop；“阿朱为什么要假扮段正淳？”这类单一人物、单一事件、单一动机问题应选择 single_retrieval。

用户问题：${state.question}
    `);
    const strategy = route.mode === "direct" ? "simple" : "complex";

    return {
      strategy,
      routeMode: route.mode,
      routeReason: route.reason,
      execution: updateExecution(state.execution, {
        node: "routeQuestion",
        durationMs: Date.now() - startedAt,
        llmCalls: { route: 1 },
        llmDurationMs: { route: Date.now() - startedAt },
      }),
    };
  };

  const prepareSingleRetrievalNode = async (state) => {
    const startedAt = Date.now();
    const item = planItemForOriginalQuestion(
      state.question,
      "直接检索原始问题，避免对单一问题进行拆解",
    );
    return {
      planItems: [item],
      planValidation: {
        status: "not_required",
        repairAttempts: 0,
        failureReasons: [],
      },
      subQuestions: [state.question],
      nextSubIdx: 0,
      currentOriginalSubQuestion: state.question,
      currentQuery: state.question,
      currentTargetPlanIndexes: [0],
      skipCurrentRetrieval: false,
      execution: updateExecution(state.execution, {
        node: "prepareSingleRetrieval",
        durationMs: Date.now() - startedAt,
      }),
    };
  };

  return { routeQuestionNode, prepareSingleRetrievalNode };
}
