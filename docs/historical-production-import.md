# 历史评价生产导入

仓库只保留一份已确认的生产导入包：`D:\19016\Documents\Workload\jufexk-production-inputs\frozen-historical-v5-candidate-v10`。配套任课关系包是 `D:\19016\Documents\Workload\jufexk-production-inputs\issue365-relation-addition-v1`。

#365 已写入生产：先补 7 条任课（`11572 → 11579`），再导入 35 条历史评价（`1239 → 1274`）。目录课程 / 教师 / marker 不变。不要再对该包 `--apply`，也不要重放更早的 522 / 164 / 120 / 12 / 64 / 357 批次。OCR 抽取与 v2 / issue111 / v5-candidate-v1..v9 入口已退役，见 [ADR-0024](./adr/0024-retire-ocr-and-old-import-packages.md)。

生产操作只允许在已批准的维护窗口执行。脚本只读取该包的 `manifest.json` 与 `importable-legacy-reviews.jsonl`。

```powershell
$env:JUFEXK_BASE_URL = 'https://courses.sein.moe'
$env:JUFEXK_ADMIN_COOKIE = 'jufexk_admin=...; jufexk_csrf=...'
$env:JUFEXK_ADMIN_CSRF = '...' # 与 cookie 中的 CSRF 一致；用已绑定学号登录 /admin 后复制
$env:JUFEXK_BACKUP_PATH = 'D:\19016\Documents\Workload\jufexk-production-inputs\backups\issue365-relations-<UTC_TIMESTAMP>.sql'
pnpm run catalog-relations:v10
# 已写入后不要再 --apply

$env:JUFEXK_BACKUP_PATH = 'D:\19016\Documents\Workload\jufexk-production-inputs\backups\issue365-historical-<UTC_TIMESTAMP>.sql'
pnpm run historical-import:v5
# 已写入后不要再 --apply
```

任何契约、哈希、marker、目录计数、导入计数或幂等复核失败都会中止。公开验收只抽查匿名文字评价，不宣称评分或身份功能已上线。

## 可配置批次导入

注册表中的批次（当前为 `qq-channel-jufe-v1`，来源标签「整理自 QQ 频道「江西财经大学」」）走另一条入口，不重放上面的 v5 冻结包。JSONL 不进仓库。

需要已绑定学号的管理员：用校园统一身份登录后打开 `/admin`，复制 `jufexk_admin` 与 `jufexk_csrf` cookie，以及与 cookie 一致的 CSRF。

```powershell
$env:JUFEXK_BASE_URL = 'https://courses.sein.moe'
$env:JUFEXK_ADMIN_COOKIE = 'jufexk_admin=...; jufexk_csrf=...'
$env:JUFEXK_ADMIN_CSRF = '...'
pnpm run historical-import:package -- --package qq-channel-jufe-v1 --file D:\path\reviews.jsonl
```

默认只做 dry-run：按每批最多 50 条调用导入接口，打印汇总和非 matched/existing 明细。全部可导入或已存在时退出码 0，否则退出码 2，不写库。

确认后再写入。`--apply` 会先对全部批次 dry-run；全部通过后，用 wrangler 把生产 D1 导出到 `JUFEXK_BACKUP_PATH`（默认 `.local-data/historical-<package>-<时间戳>.sql`，文件已存在则拒绝覆盖），然后逐批正式导入，并再 dry-run 一次，断言每条都是 existing。

```powershell
$env:JUFEXK_BACKUP_PATH = 'D:\19016\Documents\Workload\jufexk-production-inputs\backups\qq-channel-<UTC_TIMESTAMP>.sql'
pnpm run historical-import:package -- --package qq-channel-jufe-v1 --file D:\path\reviews.jsonl --apply
```

JSONL 每行使用 `course_code`、`teacher`（站内来源教师名，含重名后缀）、`body`，`key` 可选。只有规范格式 `qq-jufe:<课号>:<教师称呼>:<16 位哈希>` 的 key 会送给服务端严格比对；草稿里的旧格式 key（课名代替课号、短哈希）打印警告后忽略，以服务端计算为准。dry-run 明细会带 JSONL 行号、课号和教师名，便于回到源文件修正。`overall` / `scores` 若有值会被忽略并打印「历史评价不支持评分，已忽略」。历史评价没有评分。
