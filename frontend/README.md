# MemoRAG Frontend

P6-B 的最小 React 演示界面，覆盖 EPUB 问答、生活笔记 CRUD、索引同步重试和生活笔记问答。前端只调用 P6-A 已有 HTTP API，不包含 EPUB 上传、登录认证、SSE 或新的 RAG 能力。

## 本地启动

先在一个终端启动后端：

```bash
cd backend
npm start
```

再在另一个终端启动前端：

```bash
cd frontend
npm install
npm run dev
```

浏览器访问 `http://127.0.0.1:5173`。Vite 会把 `/api` 请求代理到 `http://127.0.0.1:3000`，不需要为本地开发修改后端 CORS。

EPUB 页面只接受已经入库的 `bookId`；当前后端没有书籍列表或上传 HTTP API，因此页面不会伪造这些功能。生活笔记页面中的 `userId` 只用于数据范围过滤，不能替代身份认证，服务仍应仅在可信的本地环境中使用。

## 验证

```bash
npm test
npm run build
```

生产构建输出到被 Git 忽略的 `dist/`。
