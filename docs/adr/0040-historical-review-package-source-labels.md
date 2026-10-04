# 可配置历史评价批次公开来源标签

腾讯表格冻结包已经进生产，新的整理稿（QQ 频道「江西财经大学」）需要同一条公开历史评价通道，但读者应该能看出这批文字从哪来。旧批次继续不公开来源。不新增 migration：`package_contract` 已经能记下包名，来源文案放在代码注册表里。

权威规格：GitHub issue #922。v5 冻结包入口保持不动，见 [ADR-0024](./0024-retire-ocr-and-old-import-packages.md)。

## 决策

- 包注册表只登记可配置批次，例如 `qq-channel-jufe-v1`（key 前缀 `qq-jufe`，来源「整理自 QQ 频道「江西财经大学」」）。`package_contract` 存包名。来源标签只从注册表来；腾讯表格旧契约没有标签。
- 管理员 `POST /api/admin/historical-review-packages/:package/imports` 挂在既有 `/api/admin/*` 会话、CSRF 与 Origin 保护后面。一次 1–50 条。`dryRun` 只出报告、不写库。正式导入先整批校验，只要有一条不是 matched 或 existing 就 422 且一行都不写。
- 稳定 key 是 `前缀:课程代码:教师称呼:规范化正文 sha256 的前 16 位`。正文先去首尾空白，再把内部连续空白折成一个空格。请求里若带 key，必须与服务端计算值相同。公开主键只允许 `[A-Za-z0-9._-]`，所以库内 id 用 `前缀-` 加稳定 key 的 sha256 前 32 位，响应同时返回 key 与 id。
- 课程、教师、任课关系分开查，缺课程、缺教师、缺关系各自成状态。批内重复 key、同 id 不同内容分别是 duplicate_in_batch 与 conflict。同任课关系已有的公开历史评价条数只作信息，不阻断。
- 写入用 `INSERT OR IGNORE`。`approved_package_manifest_sha256` 是本次请求规范化记录的 sha256；`approved_catalog_content_sha256` 取目录基线 marker，没有 marker 则 422。写入后只给本批任课关系排队重算总结。重放同一批应全部 existing。
- 课程×教师评价流、最新课评、`#000000` 主页三条 historical SELECT 带出 `package_contract`，再映射成 `source_label`。普通评价对应列为空。有标签时评价卡在作者旁显示一枚小 Chip；没有标签不渲染。
- `#000000` 简介改为「来自以前的学长学姐的评价，部分整理自 QQ 频道「江西财经大学」」。历史正文仍按纯文本渲染，不把来源列加进公开列表投影。

## 被否方案

- 只改 `#000000` 一句简介、不在评价卡上标来源。简介不能区分每一条是表格旧批次还是频道整理稿。
- 为新批次再开一个保留作者编号。公开编号 `0` 已经代表无作者的历史评价，再拆编号会把关注和主页统计拆成两套。
- 加 migration，把来源文案存进新列。另一个分支正占用下一号 migration；文案是展示副本，放注册表即可，旧行不必回填。
