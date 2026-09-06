# 测试精简实施记录

更新：2026-09-06。基线：`1eafb39`，工作分支：`codex/test-simplification`。

## 当前进度与统计口径

目标是降低测试维护和运行成本；最终取舍标准是删除冗余和高维护成本测试，同时保留独有业务边界，不为达到 80% 的数字而牺牲边界覆盖。不能以删除代码行数代替测试削减率。当前改动仍在 worktree，尚未提交、创建 PR 或通过远端 CI。

- 基线 Git 跟踪的 `test/`、`scripts/` 下测试文件：176；当前剩余：151，删除 25 个文件（14.2%）。
- 同一正则按行首统计字面量标题的 `it` / `test` 声明：1201 → 1060。该近似口径不展开 `each`、循环和 Playwright 项目副本，也不能代表完整运行用例数。
- 当前生产 Playwright 实际运行：桌面 167 个，移动 smoke 16 个。桌面与移动重复运行不算两个独立业务契约。
- 参数化合并保留原输入，不将 `it.each` 的代码缩短算成用例删除。
- 目前没有同环境、同并发数的删减前完整耗时基线；不能声称具体 CI 加速比例。

## 六类覆盖的处理依据

| 范围 | 已实施 | 保留的保护 |
| --- | --- | --- |
| 浏览器 E2E | 删除旧路由兼容、重复 preview、重复导航与部分布局细节；清理对应 helper | 登录/MFA/二维码、目录筛选、评价提交/互动、管理权限、关注/消息、排课，以及移动 smoke |
| 搜索 | 删除 ranking-quality 与 search-api 重复的精确教师/课名关系测试；删除多词排序单测中的 SQL 排版断言 | API 精确关系收窄、来源教师名、排序结果、多词 AND、拼音与转义输入、SQL 参数绑定 |
| 评价 | 删除重复的管理开关布尔测试、摘要超时常量断言；合并重复评分与链接协议输入 | 实际偏好持久化、管理权限、摘要超时行为、评分和 HTML 安全处理 |
| 公开目录投影 | 删除单独的 D1 分片算式测试 | 使用 40 个教师 × 3 个来源构造超限输入的实际 D1/API 测试；已做消融验证 |
| JWXT 本地解析 | 删除只调用 iconv-lite 对 fixture 编解码的 GBK 往返测试和无用 import | 表格解析、单双周/节次、分页/rowspan、过期登录、畸形输入、快照秘密字段拒绝、Cookie 安全 |
| 实现细节/退役功能 | 删除固定 CSS class、资产版本源码检查、部分历史导入兼容测试、catalog-baseline/program-plan 采集器测试及专用 Vitest 配置 | 数据库迁移、生产/预览部署隔离与 Queue 配置等现役契约 |

布局断言的删除是减少自动视觉回归保护的取舍，不等于其他行为测试能证明原有像素布局。第三方源码检查被删除后，也不再单独保护其内部实现形状。

## 原型与生产执行范围

- `test:workers` 和 CI Workers 分片排除 `global-search-prototype.test.ts`、`prototype-local-seed.test.ts`。
- `test:static` 排除 `page-atlas.node.test.ts`。
- `test:prototype` 分别用 Workers 与 Node 配置运行上述三份文件，避免 Node 测试被 Workers 配置静默忽略。
- 默认 Playwright 的桌面、移动项目都排除 `global-search.browser.test.ts`、`review-recognition.browser.test.ts`。移动项目的 `testIgnore` 会覆盖全局值，必须同时配置。
- `playwright.prototype.config.ts` 显式限定两个原型文件，并清空项目继承的排除项；单独使用该配置也不会跑整个生产目录。
- `docs/agents/ci.md` 已同步当前入口。普通 PR 的 `@pr-smoke` 策略已存在于基线，不能将它当作本次新增的加速成果。

## 消融：D1 分片保护

删除 `public-catalog-list-chunk.node.test.ts` 后，保留 `public-pe-relation-projection.test.ts` 的真实 API/D1 覆盖。

1. 基线运行该文件：4 个测试通过。
2. 临时把 `extraMergeChunkSize` 的预算计算返回值改为 `extraCount`，使所有额外关系进入同一条 SQL。
3. 运行同一文件：1 个测试失败、3 个通过。失败测试为 `lists relations by review count when many PE extras would exceed D1 bind limits`，API 返回 500，日志为 `D1_ERROR: too many SQL variables`。
4. 使用 `finally` 恢复原文件。修改前与恢复后 SHA-256 均为 `c748cf166a8d48c519cbe559fba662c3a5704a0c6d12a8a5319b0482ced1b7ef`，临时错误不保留在 diff。

首次带长标题过滤的实验因 Windows 命令参数解析导致所有用例跳过，已判为无效；上述有效实验直接调用 Vitest 的 Node 入口运行完整指定文件。此消融只证明取消 D1 分片这个失败面仍被捕获，不证明所有删除项覆盖等价。

## 已验证与未完成项

- 生产桌面 E2E：167/167，通过，2 workers，4.7 分钟。
- 生产移动 smoke：16/16，通过，2 workers，33.2 秒。
- 生产 Node：226/226，通过；secrets：7/7，通过。
- 搜索与公开关系投影四份保留测试：53/53，通过。
- 原型 Workers：10/10，通过；页面图集 Node：4/4，通过。
- CI workflow 契约：16/16，通过。
- 已按 `types` → TypeScript 的顺序检查；`git diff --check` 通过。
- Playwright 可执行文件缺失已通过安装锁定依赖对应的 Chromium 修复。

- 全量生产 Workers：84 文件、724/724 通过，284.31 秒。D1 消融恢复后的目标测试也在此次全量中通过。
- 构建通过；仍报告 `PublicUserFollowVariants.tsx` 同时静态/动态导入导致不能独立分块的提示，本轮未修改生产代码。
- 独立原型浏览器：12/12 通过，24.3 秒。
- 本地规范审查子代理未发现阻塞问题；需求审查子代理因额度限制退出，由主代理继续复核，不算独立审查通过。
- 主代理复核把搜索“无建议列表”、评价按钮 Enter 激活并入保留的业务流程，无需恢复两条独立 E2E；修复用户页课程数断言只适用于桌面的遗漏。针对这三处流程的回归验证为桌面 20/20、移动 1/1。

本轮以冗余和维护成本为收尾标准；当前统计的文件数减少 14.2%，标题声明近似减少 11.7%，并不宣称达到原始 80% 数字。下一步是提交、远端 CI 和合入验证。
