// 在一个AI系统里，最核心的就是几个Prompt模块。
import { ChatPromptTemplate } from "@langchain/core/prompts";
import * as z from "zod";

export const QueryAugmentSchema = z.object({
    queries: z.array(z.string())
        .length(3)
        .describe(
            "恰好3条中文检索问句:不同角度改写或扩写;保留订单号、品牌等字面信息;不要编造需求"
        )
});

const AUGMENT_PROMPT = ChatPromptTemplate.fromMessages([
    [
        "system",
        `用户会给出一个中文问题。请另外写出恰好3条检索用的问句(与原意一致，角度尽量不同)。便于搜索引擎或向量库分别召回。
        可改写说法、换提问角度、或略加限定词;专有名词、型号、订单号等必须保留原样。
        只输出结构化字段 queries(长度为3的字符串数组)
        `
    ],
    [
        "human",
        "{query}"
    ]
]);

function normalizeThreeQueries(original, list){
    const out = (list ?? [])
        .map((s) => typeof s === "string" ? s.trim() : "")
        .filter(Boolean);

    while(out.length < 3) {
        out.push(original);
    }

    return out.slice(0, 3);
}

export async function augmentQuery(chatModel, query){
    // 确保返回长度为3的queries数组
    const structured = chatModel.withStructuredOutput(QueryAugmentSchema);

    // 编排工作节点
    const chain = AUGMENT_PROMPT.pipe(structured);

    try{
        const raw = await chain.invoke({ query });

        return {
            queries: normalizeThreeQueries(query, raw.queries)
        };
    }catch(error){
        return {
            queries: normalizeThreeQueries(query, [])
        };
    }
}

export function retrievalQueryString(original, augmentation) {
    const queries = augmentation?.queries ?? [];

    return [...new Set(
        [original, ...queries]
            .map(q => String(q ?? "").trim())
            .filter(Boolean)
    )];
}