# 非官方课评@JUFE UI 基础

本文记录当前 UI 改版的已确认方向、Prototype 工作方式与视觉冻结规则。领域术语以 [`CONTEXT.md`](../../CONTEXT.md) 为准；既有产品旅程和后端约束可追溯至 [GitHub Issue #2](https://github.com/K4F7/jufexk/issues/2)。

本文取代仓库根目录原有的 `DESIGN.md`。旧文档所规定的红色强调色、独立入口页和 slogan 不再是当前设计约束。

## 目标与边界

- 产品公开名称统一为「非官方课评@JUFE」。
- UI 使用 HeroUI v3、Tailwind CSS v4 和 React Aria 的可访问交互语义。
- 保留现有 Vite、React Router、Cloudflare Worker、D1、API 与业务状态逻辑。
- HeroUI 官方 Vite Template 只作为布局、导航、主题切换和视觉原语的 donor，不整体迁移。
- 不使用 HeroUI Pro。
- 目录与公共壳已覆盖窄屏折行；`/schedule` 只做电脑端，见 [ADR-0030](../adr/0030-schedule-desktop-only.md)。

## 品牌与主题

- 使用 HeroUI Theme Builder 导出的官方 Sky preset 作为亮色和暗色主题基础。
- Sky 是品牌与主要交互色。成功、警告和危险继续使用各自的语义色，不能被 Sky 覆盖。
- **已视觉冻结（sky-tokens，#422 重开后）**：官方 Sky A 画布——HeroUI 默认浅灰底 `oklch(0.9702 0 0)`、官方 Sky accent、亮色 `--foreground: var(--eclipse)` 黑字；0.5rem 半径与默认阴影，`link=foreground`。不再使用 C 的天空色表面 tint。实现见 `src/styles/globals.css`。DEV 对照仍在 Gallery `?module=sky-tokens`。
- 初次访问跟随系统主题；用户切换亮暗模式后记住手动选择。
- 主题开关采用官方示例式亮暗图标交互。
- 使用 HeroUI 官方组件语言；后续模块可在已冻结 token 上继续压缩留白与信息密度。
- 页面 UI 不再展示「关于一门课，上过的人最清楚。」这一 slogan。

## 路由与公共框架

- `/` 重定向到 `/latest`，访问网站后立即看到最新课评，不经过独立 Landing Page。
- 公共顶部导航：左簇品牌 · `课评` / `课程` / 外链 `导师` · 居中顶栏搜索 · 右登录 + 主题切换。排课模拟只在 DEV 与预览站出现。不显示重复的首页入口。
- 品牌链接指向课评流；课程导航指向课程目录。
- 顶栏搜索提交到 `/courses?q=`（`AppShell` 的 `ShellCourseSearch`）。页内目录搜索头不是生产默认；DEV 可用 `?module=global-search` 对照 #303。
- 「写评价」不在主导航；从课程页「写点评」进入。本阶段投稿仍不要求先在导航里露出入口。
- 公共内容容器在桌面端约为 1520px。
- 首批统一范围包括公共 Shell、课程目录、课程详情和教师详情。公开教师列表已下线：`/teachers` 重定向到 `/courses`（带 `q` 时带到课程目录）。
- DEV 仍挂载 Prototype Gallery（`/prototype`，含 page-atlas）以及 live 对照 `shell-nav`、`global-search`。Gallery、Prototype 参数和切换器不得出现在生产构建中。

## 目录体验

### 课程目录

- 标题为「课程列表」，计数为「共 N 条」（按课程×教师关系行）。加载中计数行用骨架占位，避免 CLS。
- 生产搜索只在顶栏。关键词匹配课程名、课号或教师名；提交后落到 `/courses?q=`。
- 浏览框（`CoursesPage` 内联 Surface）：课程类别 pills（全部 / 通识 / 数学 / 思政 / 英语 / 体育）与排序 pills（评价数量默认 / 课程评分 `sort=rating`）。有 `q` 时默认排序按钮文案改为「相关度」。类别与排序是浏览切换，不算「筛选」。
- 院系 / 教师工具条已下线，不再作为生产目录控件。
- 结果是一行一条课程×教师：`CourseRelationRow`（课名（老师） / 星级+评价样本 / 四维档位）。数据走 `GET /api/courses?view=relations`。已删除的四列 `CourseResultTable` 与七列粗扫表都不是现行 UI。
- 评分按任课关系展示（课程×教师），不是课程级总分。无评价时显示「暂无评价」。
- 整行进入该课程×教师评价页（`/courses/:id?teacher=`）。
- 类别、排序和页码保存在 URL；进入详情再返回时恢复目录状态。
- 分页与状态见 `CatalogResultsStates`：官方 `Pagination`（上一页 / 页码 / 下一页 · 共 N 条）。
- **空态**：只有顶栏 `q` 算搜索未命中（「没有找到匹配…」+ 清空搜索）。类别无结果与真·无目录数据都用「目录暂无课程数据」。
- **加载**：首次进入用与关系行同形的骨架（20 行 + 分页占位），`aria-label="加载中…"`。已有数据再刷新时保持当前列表，并在列表上方显示官方 Spinner 行「正在更新课程目录…」。切回已加载过的类别、排序或分页时，若内存缓存仍有效则立刻还原，不转圈、不重拉。
- **收藏 / 本专业（历史决策 · Issue #73，承接 #63）**：2026-08-17 用户在已删除的 DEV 原型里选过条件密度方案 C。生产从未实现，对应 Gallery 模块与变体文件已删除。确认进入生产后另建 frontend / backend Issue。

### 教师目录

- 公开教师列表已下线。`/teachers` 重定向到 `/courses`（保留 `q`）。教师详情仍在 `/teachers/:id`。
- 评分仍严格绑定教师×课程；教师详情不展示跨课程聚合评分（Issue #153），前台不展示职称（Issue #148）。

## 详情体验

- 领域约束：学生投稿绑定**课程 + 任课教师**（见 CONTEXT），不是「只评课」也不是「只评老师」。课程级与教师级跨课程汇总评分都只是任课关系上投稿的聚合，单独「只看课」或「只看老师」的决策价值有限。
- **课程详情页**：保留为目录行导航落点。顶部摘要为左身份 / 右 Surface；自 Issue #140 起右 Surface 仅显示公开评价数，不再展示课程级评分，评分由「任课教师」区块按任课关系拆分展示。
- 课程详情和教师详情均采用单页纵向信息架构，不使用 Dashboard 式多张统计卡或不必要的 Tabs；内容容器收窄到约 880px 阅读宽度。
- 课程顶部使用紧凑摘要区：左身份（类别 Chip、课程名、课号、院系），右评价数 Surface（公开文字评价数，无课程级评分）；任课教师独立成表（教师姓名链接 · 院系 · 评分/投稿），按任课关系展示评分/投稿（Issue #239 将 #221/#223 的 Card 网格退回密表，与 `TeacherCourseTable` 对齐）。选中教师后摘要补上当前任课教师姓名链接与院系，右 Surface 改为该课程×教师评价数（Issue #289）；仍不把教师表缩进摘要。
- **课程详情页教师表与评价流互斥（Issue #252）**：`/courses/:id` 只显示任课教师表（提示「选择一位任课教师，查看这位老师在这门课的评价。」，不出现评价流）；点击教师行进入 `/courses/:id?teacher=<id>` 后只显示该课程×教师评价流，「返回任课教师」去掉参数回到教师表。选中后不渲染教师列表；当前老师改由摘要身份行展示（Issue #289）。切换教师先回表再点另一行；会话缓存仍恢复已加载页。教师姓名链接进入教师详情页。课程评价 API：`/api/courses/:id` 返回课程、教师列表、评价总数，以及按教师键索引的任课关系 AI 总结（空总结不出现）；`/api/courses/:id/reviews` 带 `teacherId` 时按 课程×教师 过滤，不带时仍返回该课全部公开评价（页面不再使用该无参视图）。
- 教师详情同样不出现跨课程聚合评分数字（Issue #153）；右 Surface 仅显示公开文字评价数。评分只出现在「任课课程」表的教师×课程行。不以星阵、环形图或进度条为主。
- 学生投稿为统一匿名文字流（Issue #68/#90）：正文以装饰引号为视觉锚点，`Separator` 分隔，分段加载；单条不展示评分与评价维度（历史评价无 overall，统一流保持现代/历史一致，见 CONTEXT §历史评价）。身份行按页面上下文取舍（2026-08-17 用户决策）：课程页评价按 课程×教师 收敛后整流同属所选教师，条目不再重复教师身份「昵称」；教师详情不再展示跨课程评价流。
- 历史文字资料匿名并入统一文字流：不包含 overall，不参与评分与排序统计。腾讯表格旧批次不公开来源；注册表批次在评价卡显示来源标签。评价流空态文案统一为「暂无评价」。
- **教师详情（视觉冻结 · 模块 11）**：单页纵向，沿用课程详情冻结语言，**不单开 A/B/C**。DEV live 对照：`?module=teacher-detail`。
  - **摘要 B**：左身份（姓名 / 院系 / 任课门数 / 简介）· 右 Surface 仅显示公开评价数（#153 移除教师级聚合评分；#148 不展示职称）。
  - **任课课程表**：课程域折叠列（课名+类别 Chip · 课号次行 / 院系 / 评分·投稿）；真实课程链接；实现见 `TeacherCourseTable`。
  - **相关投稿**：教师详情不再展示跨课程评价流；评价只在课程页按任课关系查看。
  - 返回教师目录的旧链接触发 `/teachers` → `/courses`。

## 页面状态与生产质量

- 课程目录状态由 `src/components/CatalogResultsStates.tsx` 实现：首次加载为关系行骨架（Issue #205 / #418）；已有数据刷新时保持列表，并在列表上方显示官方 Spinner 行「正在更新课程目录…」；错误用官方 Alert + 重试；空态只把顶栏 `q` 当搜索未命中，其余空结果用「目录暂无课程数据」；分页为上一页 / 页码 / 下一页并显示「共 N 条」。
- 请求失败提供重试操作。
- 搜索未命中提供清空搜索。
- 生产完成状态要求键盘可以完成导航、浏览切换和分页，焦点清晰，读屏可以识别列表、加载、错误、当前导航和行内链接。

## Prototype 原则

Prototype 用可操作、可丢弃的代码快速回答一个明确的 UI 问题。它不是静态效果图，也不是可以直接发布的生产实现。

### 真实度

- 主要模块挂载在现有真实路由与真实页面上下文中。
- 使用真实只读 API 和实际数据。
- 搜索、浏览切换、分页、课程/教师跳转、加载、错误和空结果应当可以实际操作或观察。
- 涉及学生投稿、审核、删除、导入等写操作时，使用内存状态、桩响应或明确的只读模式，不修改真实数据。
- Prototype 以帮助用户作出视觉决定为完成标准，不提前建设生产抽象或完整测试体系。

### 一次回答一个问题

每轮 Prototype 开始前必须写明要回答的问题。已经冻结的主题、Shell 和其他模块保持不变，变体只改变当前问题涉及的模块，避免同时改变过多变量。

一个变体必须与其他变体在结构、信息层级或主要操作路径上真正不同。只有颜色、圆角或间距不同的方案不构成有效变体。

### 统一预览入口

本地开发环境提供 `/prototype` Prototype Gallery。

启动方式：

1. `pnpm db:local` — 应用本地迁移（首次）
2. **接真实目录数据（推荐）**：
   - `pnpm db:export-remote` — 从远端 D1 导出到 `.local-data/remote-export.sql`（需已 `wrangler login`，文件 gitignore，约数百 MB）
   - `pnpm db:import-remote-local` — 只导入公开目录表到本地 miniflare D1（跳过 staging/provenance）
   - 备选：Windows 本机历史库在 `/mnt/d/19016/Documents/Workload/jufexk/.wrangler/state/v3/d1/`（体量远小于远端）
   - 无远端权限时才用 `pnpm db:seed-preview` 假数据。灌库后打开 `/prototype#page-atlas`，每个真实界面可进可出；左下角返回图集。
3. `pnpm dev` — Wrangler + 本地 D1/API（`http://localhost:8787`）
4. `pnpm prototype` — Vite HMR 前端（`http://localhost:5173`），`/api` 代理到 8787

必须用 Vite 入口预览 Gallery：`pnpm dev` 只服务 `dist` 生产产物，不会加载 Prototype 代码。

主要模块在真实路由上预览，数据来自本地 D1 的真实只读 API。

- 集中列出 UI 模块、当前状态和可用变体；
- 主要模块从 Gallery 进入真实课程或教师页面上下文；
- 页面底部使用浮动切换条循环切换变体（通常 A/B/C）；
- **组件官方优先**（见根目录 `AGENTS.md`）：变体优先比较不同官方组件或官方 variant，不自造控件皮肤；
- 切换变体时保留搜索、浏览和分页参数；
- URL 可复制，刷新后仍停留在同一变体；
- 小型组件可以在 Gallery 中单独并排展示；
- Gallery、Prototype 参数和切换器不得出现在生产构建中。

已删除、不要再对照的 Gallery 模块：`catalog-search`、`catalog-filters`、`course-table`、`catalog-states`、`course-detail-summary`、`course-detail-reviews`、`catalog-followup`。对应变体文件已从 `src/prototype/` 移除。

### 模块粒度

这里的「UI 模块」指用户可感知、具有独立职责和状态的产品区域，例如：

- 公共 Shell 与顶部导航（含顶栏搜索）；
- 课程目录浏览框与关系行；
- 分页与页面状态；
- 详情摘要；
- 学生投稿条目。

HeroUI Button、Chip、Input 等基础 primitive 通常不是独立的 Prototype 模块。存在真实视觉分歧的小组件可以在 Gallery 中单独比较。

### 变体数量

- 每个主要模块默认制作三个结构明显不同的变体。
- 如果模块不存在真实结构分歧，可以只做一个可操作方案供确认，不为了凑数制造差异。
- 用户可以选择一个完整变体，也可以明确组合不同变体的局部方案。

当前仍在 Gallery 的探索模块：

- **global-search（#303）**：页内目录搜索 vs 导航栏全局搜索。不改生产默认（生产已是顶栏搜索）。
- **teaching-reviews-feed（#71，承接 #68）**：任课评价文字流。
- **review-recognition（#74，承接 #70）**：任课评价认可交互。DEV 内存 stub。

仍挂载的对照 / 图集：`sky-tokens`、`shell-nav`、`teacher-detail`、page-atlas。

## 逐模块推进与冻结

UI 以模块为单位逐步推进。一个模块在真实页面上下文中完成 Prototype、由用户确认并视觉冻结后，立即并入当前页面，再开始旁边或下游的模块。

### 状态

- **探索中**：正在制作或比较方案。
- **视觉冻结**：用户确认外观已经可用；布局、信息层级和视觉语言受保护，功能与可用性仍可渐进完善。
- **生产完成**：真实功能、页面状态、桌面验收和无障碍要求均已完成。

### 视觉冻结规则

- 只有用户实际查看并明确确认后才能进入视觉冻结。
- 冻结保护布局、信息层级、视觉语言和已确认的组合关系。
- 后续允许继续调整数据接入、交互细节、错误处理和无障碍实现。
- 集成其他模块时可以调整模块外部间距，但不能暗中改变已冻结模块。
- 实质视觉变化必须明确重开该模块，使其重新进入探索中。

### 冻结记录

本文维护每个模块的状态、胜出方案、确认原因、允许变化以及 Prototype 分支或提交引用。尚未开始的模块不提前标记状态。已删除的 throwaway 变体不再当作现行对照。

| UI 模块 | 状态 | 胜出方案 | 确认原因 | Prototype 引用 |
| --- | --- | --- | --- | --- |
| Sky 主题 token | 视觉冻结 | **官方 Sky A 画布**：HeroUI 默认浅灰底 / 白表面 / 中性边框；官方 Sky accent（官网主按钮蓝）；亮色 eclipse 黑字；0.5rem 半径 / 默认阴影 / `link=foreground`。不再取 C 的天空色 tint | #422 用户对照 HeroUI 官网 hero，要求底色用官方浅灰、换用该蓝、黑字；重开原 A+C 冻结 | DEV：Gallery `sky-tokens` · `src/prototype/themes/sky-tokens.css` · 生产：`src/styles/globals.css` · Issue #422 |
| 公共 Shell 与顶部导航 | 视觉冻结（生产已演进） | Button 导航语系仍用 C：左簇字标 · `Button` `sm` 当前 `secondary` / 非当前 `ghost`。生产现为 **课程 / 课评 / 外链导师** + 居中顶栏搜索 + 右登录与主题；不再把「教师」「写评价」放进主导航 | 用户确认过 C 的 Button 语系；#402 后导航与搜索按 USTC 评课社区对齐演进 | 生产：`src/components/AppShell.tsx` · DEV 对照：`src/prototype/ShellNavVariants.tsx`（`?module=shell-nav`） |
| 目录标题与搜索 | 生产完成 | 页内标题「课程列表」+「共 N 条」；搜索在顶栏。`CatalogSearchHeader` 只留给 DEV `global-search` A | 生产默认不再用页内同行搜索头 | 生产：`AppShell` `ShellCourseSearch` · `CoursesPage` 标题行 · DEV：`?module=global-search` · Issue #303 |
| 目录浏览框 | 生产完成 | 类别 pills + 排序 pills，写在 `CoursesPage`。院系 / 教师工具条已删除 | #402 起目录按关系行浏览，不再用旧筛选工具条 | 生产：`src/pages/CoursesPage.tsx` |
| 课程目录结果 | 生产完成 | **关系行**：`CourseRelationRow`（课名（老师） / 星级+评价 / 四维）。评分绑定课程×教师 | 四列折叠表与七列粗扫都已从生产与 Gallery 删除 | 生产：`src/components/CourseRelationRow.tsx` · `GET /api/courses?view=relations` |
| 分页及加载、错误、空状态 | 生产完成 | 精简页脚 + 首次骨架；已有数据刷新时列表上方紧凑 Spinner「正在更新课程目录…」；空态只把顶栏 `q` 当搜索未命中 | 用户确认过精简页脚；#205/#418 把首次 Spinner 换成关系行骨架；#855 恢复已有数据刷新时的紧凑 Spinner | 生产：`src/components/CatalogResultsStates.tsx` |
| 课程目录整页 | 生产完成 | 顶栏搜索 · 标题+计数 · 浏览框 · 关系行 · `CatalogResultsStates` | 旧冻结栈（搜索 C · 筛选 D · 四列表 B）已不描述现行 `/courses` | 生产：`src/pages/CoursesPage.tsx` |
| 教师目录适配 | 已下线 | `/teachers` 重定向到 `/courses`。旧四列表与 `TeachersPage` 不再是公开入口 | 公开面只保留课程目录 + 教师详情 | 路由：`TeachersListRedirect` · 详情：`TeacherDetailPage` |
| 课程详情摘要 | 视觉冻结 | **B — 左身份 / 右评价数**：类别 Chip + 课程名 + 课号/院系 · 右 Surface 仅显示公开评价数；未选教师下接「任课教师」关系表，选中后只显示该教师评价流（#252），摘要补当前老师姓名链接与院系，评价数改为该课程×教师（#289） | 评价必须绑定课程+任课教师（见 CONTEXT）；#115 落地生产；#140 课程界面不出现评分；#239 密表；#252 教师表与评价流互斥；#289 互斥后摘要仍要有当前老师 | 生产：`CourseDetailPage.tsx` · `DetailSummary.tsx` · `CourseTeacherTable.tsx` · Issue #60 → #115 → #140 → #239 → #252 → #289 |
| 学生投稿条目与历史文字资料 | 视觉冻结 · 评价流仍在探索 | **统一匿名文字流**（#68/#90）：装饰引号 + 正文 + `Separator` + 分段加载；单条不展示评分/维度；课程×教师流不重复教师身份；教师详情不再展示跨课程评价流 | 历史评价无 overall（见 CONTEXT）；课程页评价按 课程×教师 收敛后教师「昵称」是冗余噪音 | 生产：`PublicReviews.tsx` · 探索：Gallery `teaching-reviews-feed` · Issue #61 → #68/#90/#71 |
| 教师详情与任课课程表 | 视觉冻结 | **课程详情语言迁移**：摘要 B · 任课表课程域折叠（评分按 教师×课程）· 教师详情不再展示跨课程评价流 | foundations 规定不单开 A/B/C | 生产：`TeacherDetailPage.tsx` · `DetailSummary.tsx` · `TeacherCourseTable.tsx` · DEV：`?module=teacher-detail` · Issue #62 · #115 → #153 |
| 任课评价认可 | 探索中 | A/B/C 比较 footer 认可按钮位置与计数 | #74 承接 #70；DEV 内存 stub，不写生产接口 | DEV：`?module=review-recognition` · `src/prototype/ReviewRecognitionVariants.tsx` |
| 页内 vs 顶栏搜索 | 探索中 | A 维持页内 / B 顶栏分组建议 / C 顶栏只跳转。生产默认已是顶栏搜索 | #303 对照用，不改生产默认 | DEV：`?module=global-search` · `src/prototype/GlobalSearchVariants.tsx` |
| 目录后续：收藏与条件密度 | 历史决策 · 原型已删 | 用户曾选 C（条件密度 + Tag 清单）。生产未实现 | 2026-08-17 选 C，取代 #63 的「A + C Tag」意向。throwaway 已从 Gallery 删除 | Issue #73（决策记录，承接 #63）。不要再打开 `catalog-followup` |

### 当前顺序

1. Sky 主题 token（冻结）
2. 公共 Shell 与顶部导航（冻结语系；生产已演进）
3. 课程目录整页（生产：顶栏搜索 + 浏览框 + `CourseRelationRow` + `CatalogResultsStates`）
4. 课程详情摘要（冻结，#115）
5. 学生投稿条目（冻结文案流；`teaching-reviews-feed` 仍探索）
6. 教师详情与任课课程表（冻结，#62）
7. **探索中**：`global-search`（#303）· `teaching-reviews-feed`（#71）· `review-recognition`（#74）

## Prototype 选择后的处理

用户选择方案后：

1. 记录胜出方案、采用原因和从其他方案吸收的部分；
2. 更新本文的模块冻结表；
3. 按生产标准重新实现胜出设计，不能直接把原型代码发布；
4. 完成类型检查、构建、浏览器桌面验收和无障碍检查；
5. 从主分支移除变体切换器与落选方案；
6. 将完整 Prototype 保存到独立 throwaway 分支，并在实现 issue 或提交中留下引用。
