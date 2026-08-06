# 数据库基线

迁移由 `@srilanka/database` 包执行。每个 SQL 文件按名称顺序执行，并将文件名与 SHA-256 校验和写入 `schema_migrations`。

```powershell
pnpm.cmd db:migrate
```

已执行迁移不得原地修改；需要修正时新增下一个有序迁移文件。开发、测试与生产必须使用不同的 `DATABASE_URL`。
