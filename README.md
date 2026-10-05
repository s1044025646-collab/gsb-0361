# Count–Min Sketch 频次估计与哈希碰撞解释后端

使用 **TypeScript + Node.js + SQLite（`node:sqlite` 内置模块）** 从零实现的非负加权事件流近似频次查询服务，
只提供 **HTTP API 与 CLI**，不含前端。可在 Windows 本地直接运行：不依赖 Docker、WSL、付费服务或任何外部在线 API，
也不使用任何现成的 Sketch 库（哈希使用 Node 内置 `node:crypto` 的 SHA-256）。

## 它做什么

对字符串键的非负加权事件流，用固定大小的 `d × w` 计数矩阵近似估计每个键的**累计权重（频次）**，
支持查询单个键、逐行解释哈希碰撞、合并参数兼容的两个摘要、导出/导入状态与查看操作历史。

明确**不做**的事：

- 不估计不同键的数量（那是 HyperLogLog 的职责）；
- 不做成员存在性判断（那是 Bloom Filter 的职责）；
- 不返回所有热门键 / Top-K（本服务只做点查询）；
- 不保存全部原始键来“代替计算”。演示与测试中出现的独立精确字典只用于**对照解释**碰撞高估，不属于摘要状态；
- 只支持标准更新：正整数权重、只加不减；**没有** conservative update、负数扣除或删除。

## 算法与确定性哈希规则

- 矩阵为 `d` 行 `w` 列，`1 ≤ d ≤ 8`，`1 ≤ w ≤ 4096`。
- 增加（update）：对每一行独立计算一个列下标，把同一正整数权重加入该行对应单元。
- 查询（point query）：返回各行对应单元计数的**最小值**作为估计。
- 哈希规则（规则版本 `cms-sha256-be-v1`）：
  1. 拼接 `种子`（uint32 大端 4 字节）`|| 行号`（uint32 大端 4 字节，行号从 0 开始）`|| 键的 UTF-8 字节`；
  2. 计算 SHA-256；
  3. 取摘要前 8 字节，按**大端**解释为无符号 64 位整数；
  4. 对 `w` 取余得到该行列下标。
- 键**区分大小写**，不做 trim、不做 Unicode 归一化；**空字符串是合法键**；包含未配对代理项（lone surrogate）的非法 Unicode 字符串会被拒绝（`INVALID_KEY`）。
- 权重与矩阵计数一律使用 `bigint` 精确整数；JSON 中以**十进制字符串**表示，超过 `Number.MAX_SAFE_INTEGER` 不丢精度。单笔权重上限 `2^64-1`。

### 矩阵与碰撞解释（示例）

参数 `w=8, d=3, seed=42`，加入 `apple×5`、`apple×3`、`banana×9` 后查询 `apple`：

| 行 | 哈希列 | 单元计数 | 是否最小值 |
|----|--------|----------|-----------|
| 0  | 7      | 8        | ✅（apple 落在这里，未被 banana 撞） |
| 1  | 6      | 8        | ✅ |
| 2  | 0      | 17       | ❌（banana 与 apple 在该行同列，计数被抬高） |

估计取最小值 **8**（真实值也是 8）。若某个从未加入的键 `ghost` 在三行都恰好撞上非零单元，
它会得到正估计——但这**不能证明它出现过**。在无负更新前提下，估计恒不低于真实频次；
不过由于碰撞的随机性，**不承诺每次误差都小于某个固定百分比**，也不承诺增大宽度后每个键的误差单调下降。

### 合并语义

- 仅当两个摘要的 `width / depth / seed`（及规则版本、编码）完全一致时可合并；
- 合并 = 两个矩阵**按单元相加**生成**全新快照**，总输入权重也相加；**不修改两个来源**；
- 合并不是集合并集：两个来源都含同一键时，该键权重相加；
- **自合并会翻倍**而不是保持不变；
- 合并满足交换律与结合律，且与“把两边事件按任意顺序连续加入”得到的矩阵一致（对应单元相等）。

### 空间上限

矩阵最大 `4096 × 8 = 32768` 个单元。持久化只存非零单元（SQLite 稀疏存储），
每个非零单元一行 `(row, col, count)`，`count` 为十进制字符串（最长 20 位），最坏情况下约几百 KB 量级。

## 目录结构

```
src/sketch.ts   标准 Count–Min Sketch、确定性哈希、参数/权重/快照校验
src/store.ts    SQLite 持久化：meta / cells（稀疏）/ history，原子事务
src/service.ts  业务编排、限额、合并、原子导入（临时库校验后落盘）
src/server.ts   纯 node:http 的 JSON API、错误码、可配置端口（默认选空闲端口）
src/cli.ts     命令行工具
src/demo.ts    碰撞解释演示（含独立精确字典对照）
test/          node:test 测试（哈希向量、大整数、空键、合并、重启、导入拒绝等）
data/          项目内数据目录（每个摘要一个 <id>.db，可用 CMS_DATA_DIR 覆盖）
```

## 环境要求

- Node.js ≥ 22.5（开发与验证使用 Node v25；用到内置 `node:sqlite`，无需安装任何原生模块）
- Windows / macOS / Linux 均可；以下命令在 Windows PowerShell 验证。

## 安装、构建、测试、启动、演示

```powershell
npm install
npm run build     # 编译到 dist/
npm test          # 编译测试并运行 node:test（22 个用例）
npm start         # 启动 API；默认自动选择 127.0.0.1 空闲端口并打印
npm run demo      # 运行碰撞解释演示（使用系统临时目录，不污染 data/）
```

可配置项（环境变量）：

- `CMS_PORT`：HTTP 端口；不设置时自动选择空闲端口。也可 `node dist/server.js 8080`。
- `CMS_DATA_DIR`：数据目录；默认项目内 `./data`。

## CLI 用法

```powershell
node dist/cli.js create  <id> --width 16 --depth 4 --seed 42
node dist/cli.js list
node dist/cli.js info    <id>
node dist/cli.js add     <id> --key apple --weight 5
node dist/cli.js batch   <id> --file examples/batch.sample.json
node dist/cli.js query   <id> --key apple
node dist/cli.js query   <id> --key ""            # 空字符串是合法键
node dist/cli.js cells   <id> --limit 50 --offset 0
node dist/cli.js history <id> --limit 50
node dist/cli.js merge   <leftId> <rightId> --target <newId>
node dist/cli.js export  <id> --file snapshot.json
node dist/cli.js import  <id> --file snapshot.json [--replace]
```

批量文件格式：`{ "entries": [ { "key": "a", "weight": 3 } ] }`，`weight` 也可以是十进制字符串。
CLI 成功输出 JSON；失败时 stderr 输出 `错误 [错误码]: 消息` 并以非零码退出。

## HTTP API

统一响应：成功 `{ "ok": true, "data": ... }`；失败 `{ "ok": false, "error": { "code", "message" } }`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/health` | 健康检查 |
| GET  | `/limits` | 当前公开限额 |
| GET  | `/v1/sketches` | 列出摘要 id（不同摘要各自独立 SQLite 文件） |
| POST | `/v1/sketches` | 创建：`{id,width,depth,seed}` |
| GET  | `/v1/sketches/:id` | 摘要信息（含总权重） |
| POST | `/v1/sketches/:id/add` | 单笔增加：`{key, weight?}`（默认 1） |
| POST | `/v1/sketches/:id/batch` | 批量增加：`{entries:[{key,weight},...]}` |
| GET/POST | `/v1/sketches/:id/query?key=` 或 body `{key}` | 点查询 + 每行下标/计数/最小值解释 |
| GET  | `/v1/sketches/:id/cells?limit=&offset=` | 查看有限的非零单元 |
| GET  | `/v1/sketches/:id/history?limit=&offset=` | 操作历史 |
| POST | `/v1/sketches/:id/merge` | `{with,target}`：与另一摘要合并到新摘要 |
| POST | `/v1/merge` | `{left,right,target}`：等价的顶层合并入口 |
| GET  | `/v1/sketches/:id/export` | 导出快照（含完整矩阵，计数为十进制字符串） |
| POST | `/v1/imports/:id` | 导入：body 为快照对象，或 `{snapshot, replace?}` |

示例（PowerShell）：

```powershell
Invoke-RestMethod http://127.0.0.1:8080/v1/sketches -Method Post `
  -ContentType application/json -Body '{"id":"s1","width":16,"depth":4,"seed":7}'
Invoke-RestMethod http://127.0.0.1:8080/v1/sketches/s1/add -Method Post `
  -ContentType application/json -Body '{"key":"apple","weight":"5000000000000000000"}'
Invoke-RestMethod "http://127.0.0.1:8080/v1/sketches/s1/query?key=apple"
```

### 公开限额（`GET /limits`）

- 请求体：1,048,576 字节（超出返回 `BODY_TOO_LARGE` / HTTP 413）；
- 单次批量：1000 条（超出 `BATCH_TOO_LARGE`）；
- 单个键：65,536 UTF-8 字节（超出 `KEY_TOO_LARGE`）；
- 单笔权重：`1..18446744073709551615`（`2^64-1`）；
- history/cells 分页上限分别为 500 与 32768。

### 错误码

`INVALID_WIDTH` / `INVALID_DEPTH` / `INVALID_SEED` / `INVALID_ID` / `INVALID_KEY` /
`INVALID_WEIGHT` / `INVALID_BATCH` / `EMPTY_BATCH` / `BATCH_TOO_LARGE` /
`BODY_TOO_LARGE` / `INVALID_JSON` / `INVALID_REQUEST` / `INVALID_CELL` /
`INVALID_SNAPSHOT`（导入校验失败）/ `CORRUPT_STATE` /
`SKETCH_EXISTS`（409）/ `SKETCH_NOT_FOUND`（404）/ `NOT_FOUND`（404）/
`INCOMPATIBLE_SKETCH`（参数不一致，拒绝合并）/ `INTERNAL`。

## 持久化与一致性

- 每个摘要在数据目录中是独立的 `<id>.db`，不同摘要的读写**物理隔离**，不可能混用状态。
- SQLite 表：`meta`（参数、规则版本、总权重、时间戳）、`cells`（只存非零单元）、`history`（append-only 操作历史）。
- 批量增加先在事务外完成全部校验，再在单个 `BEGIN IMMEDIATE` 事务内重写矩阵并更新总权重；**非法批次整体拒绝，不留下部分更新**。
- 导入先做纯内存校验（维度、非负计数、**每行单元和必须等于总权重**），再写入临时库后落到目标；校验失败不会破坏既有目标。
- 进程重启后可继续加入或合并，结果与同顺序不中断运行一致（测试覆盖）。

## 快照格式

```json
{
  "format": "cms-snapshot-v1",
  "ruleVersion": "cms-sha256-be-v1",
  "encoding": "utf8",
  "width": 16, "depth": 4, "seed": 7,
  "totalWeight": "12",
  "matrix": [["0","12", ...], ["3", ...]]
}
```

## 适用场景与限制

- 适用：高吞吐非负计数流（点击、曝光、请求量、加权埋点）的单键频次近似，内存/磁盘可预算，可跨节点合并同参数摘要。
- 限制：只有点查询，**无法列出原始键**（摘要中不保存键集合）；低宽度/高负载下碰撞会造成系统性高估；
  不支持删除与负数；合并要求参数完全一致；查询到正值不代表该键一定出现过。

## 测试覆盖

- 固定哈希输入的列下标向量（含空键、中文、不同种子/行号）；
- 大整数（`2^53+1` 级别）精确累加；空键、非法代理项、权重叠加、参数边界；
- 合并的交换律、结合律、与连续增加一致、自合并翻倍、参数不兼容拒绝；
- SQLite 快照隔离（来源不变）、重启后继续加入/合并/查询；
- 非法批次整体回滚、导入对维度/负值/行和不符的拒绝、失败不覆盖目标；
- 使用独立精确字典核对小样本“估计不低于真实频次”的高估性质。
