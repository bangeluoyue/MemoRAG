export const KNOWLEDGE_BASES = Object.freeze({
  EBOOK: "ebook",
  LIFE_NOTES: "life_notes",
});

export class RetrievalScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = "RetrievalScopeError";
  }
}

function requiredScopeValue(scope, key) {
  const value = String(scope?.[key] ?? "").trim();
  if (!value) throw new RetrievalScopeError(`scope.${key} 不能为空`);
  return value;
}

export function validateRetrievalScope(scope, expectedKnowledgeBase) {
  const knowledgeBase = requiredScopeValue(scope, "knowledgeBase");
  if (!Object.values(KNOWLEDGE_BASES).includes(knowledgeBase)) {
    throw new RetrievalScopeError(`不支持的知识库范围：${knowledgeBase}`);
  }
  if (expectedKnowledgeBase && knowledgeBase !== expectedKnowledgeBase) {
    throw new RetrievalScopeError(
      `知识库范围不匹配：期望 ${expectedKnowledgeBase}`,
    );
  }

  if (knowledgeBase === KNOWLEDGE_BASES.EBOOK) {
    return {
      knowledgeBase,
      bookId: requiredScopeValue(scope, "bookId"),
    };
  }
  return {
    knowledgeBase,
    userId: requiredScopeValue(scope, "userId"),
  };
}

export function matchesRetrievalScope(document, scope) {
  if (!document || document.knowledgeBase !== scope.knowledgeBase) return false;
  if (scope.knowledgeBase === KNOWLEDGE_BASES.EBOOK) {
    return String(document.bookId ?? "") === scope.bookId;
  }
  return String(document.userId ?? "") === scope.userId;
}

export function positiveResultLimit(value, fallback = 5) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.floor(number));
}
