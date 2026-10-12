import "dotenv/config";
import {
    // 排序 + 压缩
    BaseDocumentCompressor      // 基类
} from "@langchain/core/retrievers/document_compressors";

// 基于阿里云 重排模型，在这里封装方便替换
export class DashScopeRerank extends BaseDocumentCompressor{
    constructor({apiKey,model = "qwen3-rerank", topN = 3, baseUrl}){
        super();
        this.apiKey = apiKey;
        this.model = model;
        this.topN = topN;
        this.baseUrl = baseUrl ?? process.env.RERANK_URL;
    }

    async compressDocuments(documents, query, _callbacks){
        const res = await fetch(this.baseUrl, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: this.model,
                query,
                documents: documents.map(d => d.pageContent),
                top_n: this.topN
            })
        })
        const json = await res.json();
        if(!res.ok){
            throw new Error(`DashScope rerank ${res.status}: ${JSON.stringify(json)}`)
        }
        const results = json?.results;
        if(!Array.isArray(results)){
            throw new Error(`unexpected rerank response ${JSON.stringify(results)}` )
        }
        console.log("服务器返回的结果:",results);
        return results.map(item => documents[item.index]);
    }

}