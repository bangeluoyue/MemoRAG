import { Client } from "@elastic/elasticsearch";
import {
  KNOWLEDGE_BASES,
  createRetrievalDocument,
  matchesRetrievalScope,
  positiveResultLimit,
  validateRetrievalScope,
} from "../retrieval/index.js";

export function createElasticsearchClient({ node }) {
  return new Client({ node });
}

function numericScore(value) {
  if (value == null || value === "") return null;
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

export class ElasticsearchNotesRetriever {
  constructor({
    client,
    indexName,
    idField = "note_id",
    contentField = "content",
    userIdField = "user_id",
    knowledgeBaseField = "knowledge_base",
  }) {
    this.client = client;
    this.indexName = indexName;
    this.fields = { idField, contentField, userIdField, knowledgeBaseField };
  }

  async search(query, options = {}) {
    const result = await this.searchWithTrace(query, options);
    return result.documents;
  }

  async searchWithTrace(query, { k = 20, scope } = {}) {
    const resolvedScope = validateRetrievalScope(
      scope,
      KNOWLEDGE_BASES.LIFE_NOTES,
    );
    const rawQuery = String(query ?? "");
    if (!rawQuery.trim()) {
      return {
        documents: [],
        diagnostics: { returnedCount: 0, missingLogicalIdCount: 0, scopeFilteredCount: 0 },
      };
    }

    const limit = positiveResultLimit(k, 20);
    const {
      idField,
      contentField,
      userIdField,
      knowledgeBaseField,
    } = this.fields;
    const response = await this.client.search({
      index: this.indexName,
      size: limit,
      query: {
        bool: {
          must: [{ match: { [contentField]: { query: rawQuery } } }],
          filter: [
            { term: { [knowledgeBaseField]: resolvedScope.knowledgeBase } },
            { term: { [userIdField]: resolvedScope.userId } },
          ],
        },
      },
    });

    let missingLogicalIdCount = 0;
    let scopeFilteredCount = 0;
    const documents = [];
    for (const hit of response?.hits?.hits ?? []) {
      const source = hit?._source ?? {};
      const id = String(source[idField] ?? "").trim();
      if (!id) {
        missingLogicalIdCount += 1;
        continue;
      }
      const { [contentField]: ignoredContent, ...rawMetadata } = source;
      const document = createRetrievalDocument({
        id,
        knowledgeBase: String(source[knowledgeBaseField] ?? ""),
        userId: String(source[userIdField] ?? ""),
        content: source[contentField],
        metadata: rawMetadata,
        scores: { keyword: hit?._score },
        provenance: [{
          source: "elasticsearch",
          score: numericScore(hit?._score),
        }],
      });
      if (!matchesRetrievalScope(document, resolvedScope)) {
        scopeFilteredCount += 1;
        continue;
      }
      documents.push(document);
    }

    return {
      documents,
      diagnostics: {
        returnedCount: documents.length,
        missingLogicalIdCount,
        scopeFilteredCount,
      },
    };
  }
}
