# MemoRAG Frontend

最小 React 演示界面，覆盖登录/退出、EPUB 问答、Milvus 书名显示、管理员 EPUB 上传、生活笔记 CRUD/同步重试/问答，以及管理员重置测试员密码。认证使用后端 HttpOnly Cookie，前端不保存 Token。

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

EPUB 页面会从 Milvus 动态加载书籍列表，按书名显示下拉框并使用完整 `bookId` 发起问答；列表为空或加载失败时保留手动 `bookId` 入口。管理员上传 `.epub` 成功后会刷新列表并自动选中新书，测试员只能选择和查询既有书籍。生活笔记范围由登录会话决定，页面不再接受可任意填写的 `userId`。当前固定账号方案仍只定位为项目演示，不等同于完整的公网身份体系。

## 验证

```bash
npm test
npm run build
```

生产构建输出到被 Git 忽略的 `dist/`。
