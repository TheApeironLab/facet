# Facet

本地 TypeScript SDK + SQL CLI。业务代码通过 SDK 写入 API 数据，agent 通过标准 SQLite SQL 分析。数据和元数据保存在同一个本地 SQLite 文件，无 HTTP 服务、远端存储或模型依赖。

## 安装

需要 Node.js >=24.10，ESM。包名 `@local/facet`，尚未发布 npm。

```sh
git clone https://github.com/TheApeironLab/facet.git
cd facet
npm ci
npm test
npm pack
# 在业务项目中安装生成的包
npm install /path/to/local-facet-0.7.0.tgz
```

项目内使用 `npx --no-install facet`，全局安装后可直接运行 `facet`；源码目录先 build，再运行 `node dist/cli.js`。

## SDK 写入

```ts
import { Facet } from '@local/facet';

const facet = Facet.open({ directory: './data' });
try {
  const response = { items: [{ id: 'o1', supplier: 'A', amount: 10000 }] };
  facet.write({
    table: 'orders',
    records: response.items,
    primaryKey: ['id'],
    mode: 'upsert',
    description: '采购订单',
    grain: '一行一张订单',
    columns: { amount: { type: 'INTEGER', unit: 'CNY cent' } },
    source: { completeness: 'complete', filters: { year: 2026 } },
  });
} finally {
  await facet.close();
}
```

也可以通过 `facet.writeResponse(response, { table, select: r => r.items, ... })` 提取 API 返回记录。调用方负责 HTTP、鉴权、分页和重试。

## SDK 和 CLI 统一命名

| 能力 | SDK | CLI |
| --- | --- | --- |
| 列出表 | `facet.tables()` | `facet tables` |
| 所有表结构 | `facet.schema()` | `facet schema` |
| 指定表结构 | `facet.schema('orders')` | `facet schema orders` |
| SQL 分析 | `await facet.sql('SELECT ...', params?)` | `facet sql 'SELECT ...'` |

```sh
facet tables --directory ./data
facet schema orders --directory ./data
facet sql 'SELECT supplier, SUM(amount) AS total FROM orders GROUP BY supplier' --directory ./data
facet sql 'SELECT * FROM orders WHERE amount > ?' --params '[100]' --directory ./data
```

`tables()` 返回 name、description、rowCount 和 source。`schema()` 返回所有表的完整结构数组，`schema(name)` 返回单表结构，包括字段、主键、业务含义、粒度、来源范围、版本和关系。CLI 使用相同 SDK 实现。

其他 SDK 方法：`write`、`writeResponse`、`relate`、`drop`、`stats`、`instructions`、`tools`、`close`。`relate({ from: { table, column }, to: { table, column }, cardinality })` 声明关系，检查字段存在但不执行外键/基数校验。

可选 `facet.tools()` 返回名称为 tables/schema/sql 的三个工具，各含 name、description、inputSchema、execute。schema 工具参数为 `{ table: string }`，table 必填；省略时返回 INVALID_ARGUMENT，先用 tables 发现名称，sql 工具参数为 `{ sql, params? }`。使用 CLI 的 agent 不需要接这些工具。`facet.instructions()` 提供分析原则；仓库使用和维护指南见 [AGENTS.md](./AGENTS.md)。

## 本地存储与生命周期

SDK 显式传 directory，CLI 默认 `.facet`。两者必须指向同一目录，该目录包含 `data.sqlite` 以及运行期间可能存在的 WAL/SHM 文件。一个数据库可有多张表。SDK 自动创建目录，CLI 遇到不存在的数据库报错，不会自动创建。

重复打开同一目录可恢复数据。`await facet.close()` 停止接受新操作，等待在途查询后关闭；支持重复 close 和 `await using`。关闭后写入/元数据读取抛 FacetError，SQL/工具返回结构化错误。初始化和写入错误使用 FacetError，带稳定 code（INVALID_ARGUMENT、TYPE_MISMATCH、SCHEMA_CONFLICT、CONFLICT、NOT_FOUND、BUSY 或 STORAGE_ERROR）。writeResponse 的 select 回调失败也转换为 FacetError。

不上传数据、不采集遥测；本地文件未加密。调用方负责租户目录权限及发给模型的内容。

## 写入规则

- 默认 append：插入，重复主键报错。
- upsert：需要主键；省略字段保持原值，显式 null 清空。
- replace：事务内清空后写入，保留已有 schema。

写入及元数据更新在同一事务中，失败回滚。允许新增列；自动推断的非主键 INTEGER 列在后续页出现小数时可扩宽为 REAL，重建表和写入在同一事务中，保留已有行、索引和触发器。显式 INTEGER 不自动扩宽，返回 TYPE_MISMATCH。其他列类型及主键变化拒绝。空数组可结合 columns 创建空表。

类型为 TEXT/INTEGER/REAL/BOOLEAN/JSON；可自动推断，全空列需指定类型，混合类型默认拒绝。对象和数组存 JSON 文本；日期请规范为 ISO-8601 字符串；BOOLEAN 存 0/1。输入整数须为 JS 安全整数，大整数 ID 用字符串，精确金额建议用整数分。查询超出 JS 安全范围的整数返回十进制字符串。BLOB 返回 `{ "$type": "blob", "encoding": "base64", "data": "..." }`，可用 Buffer.from(data, "base64") 还原；空 BLOB 的 data 为空字符串。查询 schemaVersion 为 2。

表/列名需英文字母开头，后续为字母、数字或下划线；业务中文名放 description。

source 描述整张表：complete 表示 filters 范围内完整，其他状态为 partial/sampled/unknown。分页期间用 partial，全部完成再声明 complete。写入省略 source 会重置为 unknown。切换范围应 replace 或新建表；库不验证实际完整性。

## SQL 约定

SQL 仅接受单条 SELECT/WITH，不带末尾分号，参数使用 `?`。CLI 支持 `--sql-file FILE`（`-` 为 stdin）代替位置参数。默认输出 TSV，`--jsonl` 输出版本化 JSONL；`--out FILE` 导出 JSONL，拒绝覆盖已有文件。

SDK、工具和 CLI 默认均为 20 行、约 1 MiB 行 JSON、5 秒；最大 10000 行、10 MiB、30 秒。SDK 用 `Facet.open({ directory, sql: { maxRows, timeoutMs } })` 配置默认值，或通过 `sql` 第三个参数覆盖。CLI 用 `--max-rows` 和 `--timeout-ms`。

成功返回 `{ ok, columns, rows, returnedRows, truncated, dataVersions, elapsedMs, schemaVersion }`，失败返回 `{ ok: false, error: { code, message, hint? } }`。truncated 不表示总数，统计总数执行 COUNT。计算列类型可能为 null，重复列名可能在结果对象中覆盖，建议显式别名。

CLI JSONL schema 标识为 facet.cli.v2，schema 命令元数据使用 table 字段。version、updatedAt 和推断来源标记仅保留在 JSONL，不在 schema 的 TSV 中显示。退出码：0 成功、2 参数/SQL 错误、4 不存在、5 冲突、9 超时/存储故障。数据写 stdout，错误写 stderr。

查询通过有界持久子进程池、只读连接和 authorizer 执行，拒绝写入、内部表、PRAGMA、ATTACH 和扩展加载。完整输入先经过引号/注释感知的语句边界检查，拒绝引号和注释外的分号、NUL、未闭合结构，再交 SQLite 解析，不会静默忽略尾部语句。超时终止该进程，等退出后再补位；未实现 OS 内存/CPU 配额或行级权限。写入是同步事务，大批次可由宿主放后台执行。部署需保留 dist 下查询进程文件，bundler 应将本包 external。

## 0.6 迁移

这次统一接口是破坏性更新，不保留旧别名：

| 旧接口 | 新接口 |
| --- | --- |
| `datasets.write` / `datasets.fromResponse` | `write` / `writeResponse` |
| `datasets.list` / `datasets.describe` | `tables` / `schema` |
| `query` / 初始化配置 `query` | `sql` / 初始化配置 `sql` |
| `relations.add` | `relate` |
| `agent.instructions` / `agent.tools` | `instructions` / `tools` |
| 工具 list_datasets / describe_dataset / query | tables / schema / sql |
| 类型 IngestOptions / QueryOptions / QueryResult / Dataset | WriteOptions / SqlOptions / SqlResult / TableSchema |

CLI 仅保留 tables/schema/sql，移除旧的分组命令和维护入口。DataWorkspace 不再从包入口导出。SQLite 文件格式不变，无需迁移已有数据。SDK 默认结果上限由 1000 调整为 20，需要更多行时显式配置。

## 验证

```sh
npm test
npm run example
npm pack
```

测试覆盖 10 万行聚合、API 结果导入、持久化、事务回滚、查询限制、超时及 SDK/CLI/工具一致性。尚未验证具体模型的分析正确率。

## 0.7 查询池与本地 CLI 会话

```ts
const facet = Facet.open({
  directory: './data',
  pool: { maxWorkers: 2, maxQueue: 64 },
});
await facet.sql('SELECT 1'); // 首次启动查询进程
await facet.sql('SELECT 2'); // 复用进程和 SQLite 连接
console.log(facet.stats()); // workers / workerPids / queued / spawned / peakWorkers
await facet.close();       // 等待已接收任务，终止并回收所有查询进程
```

池默认最多 2 个进程、64 个等待任务，按需启动。超过等待容量立即返回 QUEUE_FULL，调用方可减小并发或稍后重试；maxQueue=0 表示不排队。timeoutMs 从提交时开始计算，包含排队和执行。崩溃任务返回 WORKER_ERROR，不重放 SQL；之后的任务自动使用替补进程。每条查询独立事务，重新读取 catalog 和版本，避免缓存旧 schema/旧数据。

上限是每个 Facet 实例的上限，不是全机器上限。业务中复用实例；同时启动很多独立 CLI 仍会创建相应进程。池在实例关闭时结束，不监听端口、没有后台服务。

重复启动普通 CLI 仍有冷启动成本。agent 可以保持一个本地 CLI 会话：

```sh
facet sql --session --directory ./data
```

通过标准输入写一行 JSON 发起一次查询，SQL 仍是 SQLite SQL，没有查询 DSL：

```jsonl
{"id":1,"sql":"SELECT count(*) AS n FROM orders"}
{"id":2,"sql":"SELECT * FROM orders WHERE amount > ?","params":[100],"maxRows":10}
```

stdout 每个请求返回一行 `{ schema, id, ...SqlResult }`；解析/查询错误按请求返回，不中断后续请求。会话顺序执行，等待输出背压，EOF 关闭本地进程及查询池。请求可传 maxRows、timeoutMs。--session 不能和位置 SQL、--sql-file、--params 或 --out 同用。

`npm run benchmark` 分别测首次查询、30 次热查询、100 并发、30 次独立 CLI 与 30 次 CLI 会话查询。基准不是性能保证，结果依运行环境和 SQL 而变。

## 删表与类型扩宽

`facet.drop('orders')` 在事务内删除表、目录元数据和所有相关关系。表不存在返回 NOT_FOUND；`facet.drop('orders', { ifExists: true })` 可安全重复，返回 `{ dropped: false }`。此能力只提供给业务 SDK，不暴露为 agent 工具或 CLI 写权限。

自动推断的列会保存 inferred 标记。INTEGER → REAL 仅对标记为推断、非主键的列自动进行；显式类型保持严格，其他漂移不会转成字符串掩盖错误。旧版无推断来源标记的 INTEGER 列按显式类型处理，调用方可通过 columns 指定 REAL 完成受控扩宽。迁移失败时数据和类型一起回滚。
