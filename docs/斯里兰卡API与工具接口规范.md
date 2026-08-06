# SrilankaOL API 与工具接口规范

**文档版本：** v0.1
**文档性质：** 前后端接口、Agent工具调用与内部服务契约规范
**适用范围：** 前端开发、后端开发、Agent编排、确定性工具、战斗模拟器、异步任务与第三方接入
**前置文档：**

- 《SrilankaOL 核心数据模型说明书》
- 《SrilankaOL 权限、情报与玩家视图说明书》
- 《SrilankaOL 页面结构与交互设计说明书》
- 《SrilankaOL 状态变更与世界版本规范》
- 《SrilankaOL 前后端系统架构说明书》
- 《SrilankaOL AI辅助与世界管理 Agent 架构说明书 v0.2》

---

# 第一章 文档目标

## 1.1 设计目的

本规范用于统一以下模块之间的数据交换方式：

- 网页前端与后端API；
- 主持人后台与状态变更系统；
- 世界管理 Agent 与只读查询工具；
- Agent与状态变更草稿生成工具；
- 后端与确定性结算工具；
- 后端与战斗模拟器；
- 后端与异步任务执行器；
- 权限系统与玩家视图生成模块。

## 1.2 核心目标

接口设计必须保证：

1. 玩家接口不会返回主持人真实数据；
2. Agent不能调用正式数据库写入接口；
3. 正式状态修改只能通过状态变更集完成；
4. 所有修改接口支持版本和并发校验；
5. 重复请求不会产生重复副作用；
6. 异步任务可以查询状态和安全重试；
7. 错误结构统一；
8. 接口结构可版本化；
9. 地图接口支持按视口和图层加载；
10. 战斗模拟结果可复现；
11. 工具输入输出能够进行严格结构校验。

---

# 第二章 接口类型

SrilankaOL中的接口分为四类。

## 2.1 外部HTTP API

供网页前端调用。

包括：

- 登录与用户；
- 游戏与季度；
- 地图；
- 国家与对象详情；
- 行动；
- 事件与任务；
- 消息与外交；
- 情报；
- 主持人后台；
- 变更集；
- 结算；
- 审计与回滚。

## 2.2 Agent工具接口

供世界管理 Agent和专项 Agent调用。

Agent工具接口必须：

- 结构化；
- 权限受限；
- 参数白名单化；
- 默认只读；
- 返回明确对象ID；
- 不允许任意SQL；
- 不允许任意代码执行。

## 2.3 内部计算工具接口

供后端调用确定性工具，例如：

- 路径计算器；
- 补给计算器；
- 经济结算器；
- 战斗模拟器；
- 冲突检测器；
- 玩家认知投影生成器。

## 2.4 异步任务接口

用于：

- AI生成；
- 报告生成；
- 通知发送；
- 地图缓存；
- 批量模拟；
- 数据一致性检查；
- 导入导出。

---

# 第三章 通用接口规范

## 3.1 基础路径

建议外部API使用统一版本前缀：

```text
/api/v1
```

例如：

```text
GET /api/v1/games/{gameId}
GET /api/v1/games/{gameId}/map/tiles
POST /api/v1/games/{gameId}/actions
```

## 3.2 接口版本

不兼容的接口修改应提升主版本。

例如：

```text
/api/v1
/api/v2
```

同一主版本内可以增加可选字段，但不得改变已有字段含义。

## 3.3 数据格式

默认使用JSON。

文件上传使用：

```text
multipart/form-data
```

地图图片、导出文件和附件通过文件接口或授权链接访问。

## 3.4 时间格式

所有接口时间统一使用ISO 8601格式，并包含时区。

示例：

```text
2026-08-06T15:30:00+08:00
```

游戏内年份和季度使用独立字段，不使用现实日期代替。

## 3.5 标识符

所有业务对象使用不可预测的唯一标识。

接口不得依赖数据库自增序号作为公开安全边界。

## 3.6 枚举值

枚举值使用稳定的英文代码，例如：

```text
Draft
Submitted
PendingApproval
Applied
Invalidated
```

前端显示文本由本地化层决定。

## 3.7 空值与未知值

必须区分：

- 字段不存在；
- 字段为空；
- 字段不可见；
- 字段未知；
- 字段已过时。

玩家视图不得用`0`或空字符串表示未知信息。

建议使用：

```json
{
  "knowledgeState": "Unknown",
  "value": null
}
```

---

# 第四章 通用请求头

## 4.1 身份认证

请求使用安全会话或访问令牌。

示例：

```text
Authorization: Bearer <token>
```

## 4.2 请求追踪

客户端可以传入：

```text
X-Request-Id
```

服务端若未收到，应自动生成。

## 4.3 幂等键

具有副作用且可能重试的接口应支持：

```text
Idempotency-Key
```

适用于：

- 提交行动；
- 批准变更集；
- 发布季度；
- 发起回滚；
- 创建外交协议；
- 启动战斗模拟。

## 4.4 乐观并发

更新草稿或对象时，可以使用：

```text
If-Match: <objectVersion>
```

或在请求体中传入：

```json
{
  "expectedVersion": 12
}
```

## 4.5 玩家视角

普通玩家视角由服务端根据身份确定。

主持人预览玩家视角时，可以使用明确的主持人专用参数，不允许普通玩家指定其他国家视角。

---

# 第五章 通用响应结构

## 5.1 成功响应

单对象响应建议使用：

```json
{
  "data": {},
  "meta": {
    "requestId": "req_xxx",
    "worldVersion": 125
  }
}
```

列表响应建议使用：

```json
{
  "data": [],
  "page": {
    "cursor": null,
    "nextCursor": "next_xxx",
    "hasMore": true
  },
  "meta": {
    "requestId": "req_xxx",
    "worldVersion": 125
  }
}
```

## 5.2 异步任务响应

```json
{
  "data": {
    "jobId": "job_xxx",
    "status": "Pending"
  },
  "meta": {
    "requestId": "req_xxx"
  }
}
```

## 5.3 变更预览响应

```json
{
  "data": {
    "changeSetId": "cs_xxx",
    "status": "PendingApproval",
    "baseWorldVersion": 125,
    "operations": [],
    "conflicts": [],
    "warnings": []
  }
}
```

---

# 第六章 统一错误结构

## 6.1 错误响应

```json
{
  "error": {
    "code": "WORLD_VERSION_CONFLICT",
    "message": "当前世界状态已发生变化，请重新检查该操作。",
    "details": {},
    "retryable": false
  },
  "meta": {
    "requestId": "req_xxx"
  }
}
```

## 6.2 常用错误代码

### 认证与权限

- `UNAUTHENTICATED`
- `ACCESS_DENIED`
- `GAME_MEMBERSHIP_REQUIRED`
- `HOST_PERMISSION_REQUIRED`
- `OBJECT_NOT_VISIBLE`
- `ATTRIBUTE_NOT_VISIBLE`

### 对象与输入

- `OBJECT_NOT_FOUND`
- `OBJECT_AMBIGUOUS`
- `INVALID_OBJECT_TYPE`
- `INVALID_ARGUMENT`
- `INVALID_ENUM_VALUE`
- `VALIDATION_FAILED`

### 版本与冲突

- `OBJECT_VERSION_CONFLICT`
- `WORLD_VERSION_CONFLICT`
- `CHANGESET_CONFLICT`
- `PRECONDITION_FAILED`
- `RESOURCE_CONFLICT`
- `ACTOR_CONFLICT`
- `STAGE_CONFLICT`

### 流程

- `QUARTER_NOT_OPEN`
- `ACTION_SUBMISSION_LOCKED`
- `INVALID_STATE_TRANSITION`
- `CHANGESET_NOT_APPROVABLE`
- `CHANGESET_ALREADY_APPLIED`

### 工具与AI

- `TOOL_EXECUTION_FAILED`
- `AGENT_OUTPUT_INVALID`
- `AGENT_CONTEXT_DENIED`
- `MODEL_UNAVAILABLE`
- `TOKEN_BUDGET_EXCEEDED`
- `SIMULATION_FAILED`

### 系统

- `INTERNAL_ERROR`
- `SERVICE_UNAVAILABLE`
- `RATE_LIMITED`
- `ASYNC_JOB_FAILED`

---

# 第七章 身份与游戏成员API

## 7.1 当前用户

```text
GET /api/v1/me
```

返回：

- 用户ID；
- 显示名称；
- 系统角色；
- 当前可访问游戏；
- 未读通知数量。

## 7.2 游戏列表

```text
GET /api/v1/games
```

只返回当前用户有权访问的游戏。

## 7.3 游戏成员

主持人接口：

```text
GET /api/v1/games/{gameId}/members
POST /api/v1/games/{gameId}/members
PATCH /api/v1/games/{gameId}/members/{memberId}
```

玩家不得调用主持人成员管理接口。

## 7.4 玩家与国家绑定

```text
POST /api/v1/games/{gameId}/country-assignments
```

请求示例：

```json
{
  "memberId": "member_xxx",
  "countryId": "country_xxx",
  "role": "PrimaryController"
}
```

---

# 第八章 游戏与季度API

## 8.1 游戏详情

```text
GET /api/v1/games/{gameId}
```

玩家返回玩家视图。

主持人返回主持人视图。

## 8.2 当前季度

```text
GET /api/v1/games/{gameId}/quarters/current
```

返回：

- 游戏年份；
- 季节；
- 流程状态；
- 行动截止时间；
- 玩家待办；
- 是否允许修改行动；
- 当前世界版本。

## 8.3 季度列表

```text
GET /api/v1/games/{gameId}/quarters
```

## 8.4 主持人切换季度状态

```text
POST /api/v1/games/{gameId}/quarters/{quarterId}/transition
```

请求示例：

```json
{
  "targetState": "Locked",
  "reason": "行动提交截止"
}
```

状态切换必须校验合法状态机。

## 8.5 发布季度结果

```text
POST /api/v1/games/{gameId}/quarters/{quarterId}/publish
```

请求应包含：

- 预期世界版本；
- 待发布叙事版本；
- 主持人确认；
- 幂等键。

---

# 第九章 地图API

## 9.1 地图基础信息

```text
GET /api/v1/games/{gameId}/map
```

返回：

- 地图ID；
- 坐标类型；
- 尺寸；
- 可用缩放级别；
- 当前世界版本；
- 玩家可用图层。

## 9.2 地图视口查询

```text
GET /api/v1/games/{gameId}/map/viewport
```

查询参数：

- `minQ`
- `maxQ`
- `minR`
- `maxR`
- `zoom`
- `layers`
- `worldVersion`

示例：

```text
GET /map/viewport?minQ=10&maxQ=30&minR=5&maxR=25&zoom=4&layers=terrain,control,city,army
```

返回内容必须经过玩家认知过滤。

## 9.3 地块详情

```text
GET /api/v1/games/{gameId}/tiles/{tileId}
```

玩家响应可能只包含：

- 已知地形；
- 已知控制者；
- 已发现城市；
- 已知军队；
- 情报时间。

主持人响应包含完整状态。

## 9.4 地块邻接

```text
GET /api/v1/games/{gameId}/tiles/{tileId}/neighbors
```

用于前端路径预览和对象导航。

## 9.5 地图对象搜索

```text
GET /api/v1/games/{gameId}/map/search?q={keyword}
```

搜索结果必须经过权限过滤。

## 9.6 地图编辑草稿

主持人接口：

```text
POST /api/v1/games/{gameId}/map/edit-drafts
PATCH /api/v1/games/{gameId}/map/edit-drafts/{draftId}
POST /api/v1/games/{gameId}/map/edit-drafts/{draftId}/create-change-set
```

地图编辑不得直接修改正式地块。

---

# 第十章 世界对象API

## 10.1 通用对象查询

```text
GET /api/v1/games/{gameId}/objects/{objectId}
```

返回具体视图模型，不直接返回通用数据库实体。

## 10.2 对象类型列表

```text
GET /api/v1/games/{gameId}/objects?type=City
```

支持：

- 类型；
- 状态；
- 所属国家；
- 所属地区；
- 分页；
- 搜索关键词。

## 10.3 对象历史

```text
GET /api/v1/games/{gameId}/objects/{objectId}/history
```

玩家只返回其有权看到的历史。

## 10.4 对象关系

```text
GET /api/v1/games/{gameId}/objects/{objectId}/relations
```

## 10.5 自定义属性

主持人读取：

```text
GET /api/v1/games/{gameId}/objects/{objectId}/custom-properties
```

正式修改必须生成变更集，不提供直接PATCH正式属性的接口。

## 10.6 对象编辑草稿

```text
POST /api/v1/games/{gameId}/objects/{objectId}/edit-drafts
PATCH /api/v1/games/{gameId}/object-edit-drafts/{draftId}
POST /api/v1/games/{gameId}/object-edit-drafts/{draftId}/create-change-set
```

---

# 第十一章 国家、城市与军队视图API

## 11.1 国家详情

```text
GET /api/v1/games/{gameId}/countries/{countryId}
```

后端根据请求者返回：

- `OwnerCountryView`
- `ForeignCountryView`
- `HostCountryView`
- `PublicCountryView`

## 11.2 城市详情

```text
GET /api/v1/games/{gameId}/cities/{cityId}
```

## 11.3 军队列表

```text
GET /api/v1/games/{gameId}/armies
```

查询参数可以包括：

- 所属国家；
- 地块；
- 状态；
- 补给状态；
- 是否参战；
- 是否为本国。

## 11.4 军队详情

```text
GET /api/v1/games/{gameId}/armies/{armyId}
```

敌军视图不得返回隐藏字段。

## 11.5 路线预览

```text
POST /api/v1/games/{gameId}/armies/{armyId}/route-preview
```

请求：

```json
{
  "destinationTileId": "tile_xxx",
  "waypoints": [],
  "avoidConditions": ["EnemyControlled"],
  "expectedWorldVersion": 125
}
```

返回：

- 推荐路线；
- 移动消耗；
- 可见风险；
- 补给风险；
- 预计终点。

不得泄露玩家未知敌军。

---

# 第十二章 玩家行动API

## 12.1 创建草稿

```text
POST /api/v1/games/{gameId}/actions
```

请求示例：

```json
{
  "quarterId": "quarter_xxx",
  "category": "Custom",
  "title": "策反守城军官",
  "originalText": "尝试联系城内不满的守军军官……",
  "targetObjectIds": ["city_xxx"],
  "actorObjectIds": ["character_xxx"],
  "secrecy": "OwnerOnly"
}
```

## 12.2 修改草稿

```text
PATCH /api/v1/games/{gameId}/actions/{actionId}
```

必须校验：

- 行动仍为草稿或可修改状态；
- 当前用户拥有该行动；
- 版本未冲突。

## 12.3 提交行动

```text
POST /api/v1/games/{gameId}/actions/{actionId}/submit
```

必须使用幂等键。

## 12.4 撤回行动

```text
POST /api/v1/games/{gameId}/actions/{actionId}/withdraw
```

是否允许撤回由季度状态和主持人规则决定。

## 12.5 行动详情

```text
GET /api/v1/games/{gameId}/actions/{actionId}
```

玩家只能读取自己有权查看的版本。

## 12.6 行动版本

```text
GET /api/v1/games/{gameId}/actions/{actionId}/versions
```

保留：

- 玩家原文；
- 主持人整理；
- AI结构化；
- 最终行动单。

---

# 第十三章 主持人行动审核API

## 13.1 审核队列

```text
GET /api/v1/games/{gameId}/host/actions/review-queue
```

筛选条件：

- 国家；
- 行动类型；
- 状态；
- 是否需要补充；
- 是否涉及冲突；
- 是否已调用AI。

## 13.2 创建主持人解释

```text
POST /api/v1/games/{gameId}/host/actions/{actionId}/interpretations
```

## 13.3 请求玩家补充

```text
POST /api/v1/games/{gameId}/host/actions/{actionId}/request-input
```

请求：

```json
{
  "message": "请明确目标城市和投入的执行主体。",
  "requiredFields": ["targetCity", "actor"]
}
```

## 13.4 批准正式行动单

```text
POST /api/v1/games/{gameId}/host/actions/{actionId}/approve
```

## 13.5 拒绝行动

```text
POST /api/v1/games/{gameId}/host/actions/{actionId}/reject
```

必须记录原因。

## 13.6 创建状态变更草稿

```text
POST /api/v1/games/{gameId}/host/actions/{actionId}/change-set-draft
```

---

# 第十四章 事件与任务API

## 14.1 玩家事件列表

```text
GET /api/v1/games/{gameId}/events
```

只返回玩家可见事件。

## 14.2 事件详情

```text
GET /api/v1/games/{gameId}/events/{eventId}
```

## 14.3 事件回应

```text
POST /api/v1/games/{gameId}/events/{eventId}/responses
```

支持：

- 标准选项；
- 自定义回应；
- 对象引用；
- 保密要求。

## 14.4 任务路线

```text
GET /api/v1/games/{gameId}/mission-routes
GET /api/v1/games/{gameId}/mission-routes/{routeId}
```

响应只包含已解锁或允许展示的节点。

## 14.5 主持人事件管理

```text
POST /api/v1/games/{gameId}/host/events
PATCH /api/v1/games/{gameId}/host/events/{eventId}
POST /api/v1/games/{gameId}/host/events/{eventId}/activate
```

事件正式结果仍通过状态变更集执行。

---

# 第十五章 消息与外交API

## 15.1 会话列表

```text
GET /api/v1/games/{gameId}/conversations
```

## 15.2 创建会话

```text
POST /api/v1/games/{gameId}/conversations
```

请求示例：

```json
{
  "type": "BilateralDiplomacy",
  "participantCountryIds": ["country_a", "country_b"],
  "title": "边境谈判"
}
```

服务端必须校验创建者是否有资格邀请相关参与者。

## 15.3 发送消息

```text
POST /api/v1/games/{gameId}/conversations/{conversationId}/messages
```

## 15.4 消息列表

```text
GET /api/v1/games/{gameId}/conversations/{conversationId}/messages
```

使用游标分页。

## 15.5 正式外交提案

```text
POST /api/v1/games/{gameId}/treaty-proposals
```

## 15.6 确认条款

```text
POST /api/v1/games/{gameId}/treaty-proposals/{proposalId}/confirm
```

## 15.7 主持人批准协议

```text
POST /api/v1/games/{gameId}/host/treaty-proposals/{proposalId}/approve
```

批准后生成正式外交变更集。

---

# 第十六章 情报与玩家认知API

## 16.1 情报报告列表

```text
GET /api/v1/games/{gameId}/intelligence/reports
```

## 16.2 情报详情

```text
GET /api/v1/games/{gameId}/intelligence/reports/{reportId}
```

玩家响应不得包含：

- 真实值；
- 后台真实性字段；
- 主持人备注。

## 16.3 情报网络列表

```text
GET /api/v1/games/{gameId}/intelligence/networks
```

仅返回本国拥有或有权查看的网络。

## 16.4 对象认知详情

```text
GET /api/v1/games/{gameId}/perception/objects/{objectId}
```

返回：

- 当前主认知；
- 信息来源；
- 可信度；
- 精度；
- 更新时间；
- 矛盾情报。

## 16.5 主持人认知对比

```text
GET /api/v1/games/{gameId}/host/perception/compare
```

查询参数：

- `objectId`
- `countryIds`

返回真实状态与各国认知差异。

---

# 第十七章 主持人玩家视角预览API

## 17.1 创建预览会话

```text
POST /api/v1/games/{gameId}/host/view-previews
```

请求：

```json
{
  "targetMemberId": "member_xxx",
  "targetCountryId": "country_xxx"
}
```

## 17.2 使用预览视角查询

主持人预览接口使用独立预览令牌或预览会话ID。

预览接口必须：

- 明确返回`previewMode: true`；
- 禁止通过预览身份提交玩家操作；
- 记录主持人预览行为。

## 17.3 结束预览

```text
DELETE /api/v1/games/{gameId}/host/view-previews/{previewId}
```

---

# 第十八章 状态变更集API

## 18.1 创建变更集草稿

```text
POST /api/v1/games/{gameId}/change-sets
```

请求示例：

```json
{
  "quarterId": "quarter_xxx",
  "stage": "MilitaryMovement",
  "sourceType": "HostManualEdit",
  "sourceId": "action_xxx",
  "summary": "A军进入A城",
  "baseWorldVersion": 125,
  "operations": []
}
```

普通玩家无权调用。

## 18.2 获取变更集

```text
GET /api/v1/games/{gameId}/change-sets/{changeSetId}
```

## 18.3 修改草稿

```text
PATCH /api/v1/games/{gameId}/change-sets/{changeSetId}
```

只有草稿或待处理状态允许修改。

## 18.4 检查变更集

```text
POST /api/v1/games/{gameId}/change-sets/{changeSetId}/check
```

返回：

- 前置条件结果；
- 读写冲突；
- 资源冲突；
- 权限警告；
- 叙事警告；
- 世界版本状态。

## 18.5 批准变更集

```text
POST /api/v1/games/{gameId}/change-sets/{changeSetId}/approve
```

请求：

```json
{
  "expectedWorldVersion": 125,
  "approvalReason": "主持人确认离间行动和城内战斗结果",
  "confirmHighRiskOperations": true
}
```

## 18.6 正式应用变更集

批准与应用可以分为两个接口：

```text
POST /api/v1/games/{gameId}/change-sets/{changeSetId}/apply
```

只有主持人或受控系统流程可以调用。

## 18.7 拒绝变更集

```text
POST /api/v1/games/{gameId}/change-sets/{changeSetId}/reject
```

## 18.8 生成反向变更草稿

```text
POST /api/v1/games/{gameId}/change-sets/{changeSetId}/reverse-draft
```

该接口只生成草稿，不直接撤销。

---

# 第十九章 变更操作结构

## 19.1 标准结构

```json
{
  "operationId": "op_xxx",
  "operationType": "SetValue",
  "targetObjectId": "city_xxx",
  "targetField": "publicOrder",
  "oldValue": 52,
  "newValue": 35,
  "critical": false,
  "reason": "连续征税导致不满",
  "preconditions": [],
  "visibility": {
    "type": "OwnerOnly"
  }
}
```

## 19.2 前置条件结构

```json
{
  "type": "FieldEquals",
  "objectId": "city_xxx",
  "field": "controllerCountryId",
  "expectedValue": "country_b"
}
```

## 19.3 对象创建操作

```json
{
  "operationType": "CreateObject",
  "objectType": "Outpost",
  "temporaryReference": "new_observation_post_1",
  "initialValues": {
    "name": "隐蔽观察站",
    "tileId": "tile_xxx",
    "ownerCountryId": "country_a"
  }
}
```

同一变更集后续操作可以引用临时引用。

## 19.4 移动操作

```json
{
  "operationType": "MoveObject",
  "targetObjectId": "army_xxx",
  "fromObjectId": "tile_a",
  "toObjectId": "tile_b",
  "routeId": "route_xxx"
}
```

---

# 第二十章 冲突组API

## 20.1 冲突组列表

```text
GET /api/v1/games/{gameId}/conflict-groups
```

## 20.2 创建冲突组

```text
POST /api/v1/games/{gameId}/conflict-groups
```

## 20.3 添加行动或变更集

```text
POST /api/v1/games/{gameId}/conflict-groups/{groupId}/members
```

## 20.4 分析冲突

```text
POST /api/v1/games/{gameId}/conflict-groups/{groupId}/analyze
```

可以调用：

- 确定性冲突检测器；
- 规则审查 Agent；
- 路径或战斗工具。

## 20.5 提交统一结果

```text
POST /api/v1/games/{gameId}/conflict-groups/{groupId}/resolve
```

请求应引用最终统一变更集。

---

# 第二十一章 季度结算API

## 21.1 结算看板

```text
GET /api/v1/games/{gameId}/quarters/{quarterId}/resolution-board
```

返回各阶段：

- 待处理数量；
- 已完成数量；
- 冲突数量；
- 阻塞项；
- 是否可继续。

## 21.2 执行确定性阶段结算

```text
POST /api/v1/games/{gameId}/quarters/{quarterId}/calculations/{calculationType}
```

例如：

```text
/calculations/economy
/calculations/research
/calculations/construction
/calculations/maintenance
```

响应生成候选变更集或异步任务。

## 21.3 阶段完成

```text
POST /api/v1/games/{gameId}/quarters/{quarterId}/stages/{stage}/complete
```

系统必须检查该阶段无阻塞项。

## 21.4 结算一致性检查

```text
POST /api/v1/games/{gameId}/quarters/{quarterId}/validate
```

检查：

- 资源一致性；
- 军队位置；
- 城市控制；
- 外交状态；
- 权限；
- 玩家认知；
- 待发布叙事。

---

# 第二十二章 世界管理 Agent API

## 22.1 创建Agent任务

```text
POST /api/v1/games/{gameId}/host/agent-tasks
```

请求示例：

```json
{
  "taskType": "WorldManagement",
  "input": "玩家A发动离间计，守城军官打开城门。",
  "contextObjectIds": ["city_xxx", "army_xxx"],
  "quarterId": "quarter_xxx",
  "preferredMode": "CostBalanced"
}
```

## 22.2 Agent任务状态

```text
GET /api/v1/games/{gameId}/host/agent-tasks/{taskId}
```

## 22.3 Agent输出

返回：

- 任务解释；
- 识别对象；
- 歧义对象；
- 使用工具；
- 规则警告；
- 建议状态变更；
- Token使用；
- 模型信息。

## 22.4 确认歧义对象

```text
POST /api/v1/games/{gameId}/host/agent-tasks/{taskId}/resolve-ambiguities
```

## 22.5 继续任务

```text
POST /api/v1/games/{gameId}/host/agent-tasks/{taskId}/continue
```

## 22.6 生成变更集草稿

```text
POST /api/v1/games/{gameId}/host/agent-tasks/{taskId}/create-change-set
```

Agent任务不得直接调用应用变更集接口。

---

# 第二十三章 Agent工具接口通用规范

## 23.1 工具定义

每个Agent工具必须定义：

- 唯一名称；
- 描述；
- 输入结构；
- 输出结构；
- 所需权限；
- 是否只读；
- 最大返回数量；
- 超时；
- 错误代码；
- 是否允许专项Agent调用。

## 23.2 工具命名

建议采用：

```text
world.search_objects
world.get_object
world.get_related_objects
map.get_tiles
map.calculate_route
rules.check_action
changes.create_draft
battle.prepare_input
```

## 23.3 只读工具

首版Agent默认可使用：

- 对象搜索；
- 对象详情；
- 相关历史摘要；
- 当前季度；
- 适用规则；
- 路径计算；
- 战斗输入准备；
- 冲突检查。

## 23.4 草稿工具

Agent可以调用生成草稿的工具：

- 创建行动结构草稿；
- 创建事件草稿；
- 创建状态变更草稿；
- 创建叙事草稿。

草稿工具不写正式世界。

## 23.5 禁止工具

Agent不得调用：

- 任意SQL；
- 任意Shell；
- 任意文件读取；
- 数据库删除；
- 正式变更集应用；
- 季度回滚；
- 用户权限提升；
- 密钥读取。

---

# 第二十四章 Agent对象搜索工具

## 24.1 工具名称

```text
world.search_objects
```

## 24.2 输入

```json
{
  "query": "A城",
  "objectTypes": ["City"],
  "gameId": "game_xxx",
  "limit": 10,
  "contextObjectIds": []
}
```

## 24.3 输出

```json
{
  "matches": [
    {
      "objectId": "city_xxx",
      "objectType": "City",
      "displayName": "A城",
      "context": "北方省，当前由B国控制",
      "confidence": "High"
    }
  ]
}
```

## 24.4 歧义处理

多个结果相近时，工具不得自动选择。

Agent必须将候选交由主持人确认。

---

# 第二十五章 Agent对象详情工具

## 25.1 工具名称

```text
world.get_object_context
```

## 25.2 输入

```json
{
  "objectId": "city_xxx",
  "include": ["currentState", "importantHistory", "relations", "activeEffects"],
  "permissionProjection": "HostTask"
}
```

## 25.3 输出限制

只返回任务需要的数据。

不得默认返回对象全部历史和所有秘密关联。

---

# 第二十六章 Agent规则查询工具

## 26.1 工具名称

```text
rules.get_applicable_rules
```

## 26.2 输入

```json
{
  "taskType": "SiegeSpecialEvent",
  "objectIds": ["city_xxx", "army_xxx"],
  "quarterStage": "SiegeAndOccupation"
}
```

## 26.3 输出

返回：

- 规则ID；
- 规则摘要；
- 强制条件；
- 可由主持人裁决部分；
- 相关参数；
- 规则版本。

---

# 第二十七章 Agent变更草稿工具

## 27.1 工具名称

```text
changes.create_draft
```

## 27.2 输入

```json
{
  "summary": "部分守军打开城门",
  "baseWorldVersion": 125,
  "quarterId": "quarter_xxx",
  "stage": "SiegeAndOccupation",
  "operations": []
}
```

## 27.3 权限限制

该工具只创建候选变更集。

返回状态必须为：

```text
Draft
```

不得自动批准或应用。

---

# 第二十八章 路径计算工具接口

## 28.1 工具名称

```text
map.calculate_route
```

## 28.2 输入

```json
{
  "gameId": "game_xxx",
  "worldVersion": 125,
  "armyId": "army_xxx",
  "startTileId": "tile_a",
  "destinationTileId": "tile_b",
  "waypoints": [],
  "movementBudget": 6,
  "knowledgeProjectionCountryId": "country_a"
}
```

## 28.3 输出

```json
{
  "route": ["tile_a", "tile_c", "tile_b"],
  "totalCost": 5,
  "reachableThisQuarter": true,
  "visibleRisks": [],
  "supplyAssessment": "Strained",
  "warnings": []
}
```

路径工具用于玩家预览时，只能使用玩家已知风险。

主持人结算时可以使用真实世界状态。

---

# 第二十九章 经济与进度工具接口

## 29.1 经济结算

```text
economy.calculate_quarter
```

输入：

- 游戏；
- 季度；
- 国家；
- 世界版本；
- 规则版本。

输出：

- 收入；
- 支出；
- 利息；
- 异常；
- 状态变更草稿。

## 29.2 建设进度

```text
construction.calculate_progress
```

## 29.3 研究进度

```text
research.calculate_progress
```

## 29.4 状态效果到期

```text
effects.calculate_expiration
```

所有工具必须返回使用的规则版本。

---

# 第三十章 战斗模拟器接口

## 30.1 创建模拟任务

```text
POST /api/v1/games/{gameId}/battles/simulations
```

请求：

```json
{
  "battleDraftId": "battle_draft_xxx",
  "worldVersion": 125,
  "simulatorVersion": "0.1.0",
  "randomSeed": "seed_xxx",
  "participants": [],
  "terrain": {},
  "battleWidth": 20,
  "approvedTacticalParameters": []
}
```

## 30.2 模拟结果

```json
{
  "simulationId": "sim_xxx",
  "status": "Succeeded",
  "result": {
    "winnerSide": "A",
    "phaseCount": 6,
    "participantResults": [],
    "retreats": [],
    "phaseLogs": []
  },
  "reproducibility": {
    "randomSeed": "seed_xxx",
    "simulatorVersion": "0.1.0",
    "inputHash": "hash_xxx"
  }
}
```

## 30.3 转换为变更集

```text
POST /api/v1/games/{gameId}/battles/simulations/{simulationId}/create-change-set
```

## 30.4 主持人调整

主持人调整战斗结果时，应创建调整记录，不得修改原始模拟输出。

---

# 第三十一章 叙事生成接口

## 31.1 创建叙事任务

```text
POST /api/v1/games/{gameId}/narrative-jobs
```

请求：

```json
{
  "sourceChangeSetIds": ["cs_xxx"],
  "targetView": {
    "type": "Country",
    "countryId": "country_a"
  },
  "artifactType": "QuarterReport",
  "worldVersion": 126,
  "perceptionVersion": 44
}
```

## 31.2 叙事生成约束

后端必须先生成感知投影，再向叙事Agent发送数据。

不得将真实完整状态和“请勿泄露”的提示同时发送。

## 31.3 发布叙事

```text
POST /api/v1/games/{gameId}/narratives/{narrativeId}/publish
```

发布前执行：

- 世界版本检查；
- 感知版本检查；
- 权限检查；
- 事实一致性检查。

---

# 第三十二章 异步任务API

## 32.1 查询任务

```text
GET /api/v1/jobs/{jobId}
```

## 32.2 取消任务

```text
POST /api/v1/jobs/{jobId}/cancel
```

只有未进入不可中断阶段的任务可以取消。

## 32.3 重试任务

```text
POST /api/v1/jobs/{jobId}/retry
```

需要幂等控制。

## 32.4 任务结果

任务结果应保存引用，不应在状态接口中返回超大数据。

例如战斗日志或导出文件通过独立资源接口读取。

---

# 第三十三章 通知API

## 33.1 通知列表

```text
GET /api/v1/notifications
```

## 33.2 标记已读

```text
POST /api/v1/notifications/{notificationId}/read
```

## 33.3 批量已读

```text
POST /api/v1/notifications/read
```

## 33.4 通知跳转

通知返回：

- 类型；
- 关联对象；
- 关联页面；
- 优先级；
- 是否阻塞。

前端不得根据通知文本自行推断跳转路径。

---

# 第三十四章 审计与历史API

## 34.1 对象审计

主持人接口：

```text
GET /api/v1/games/{gameId}/host/audit
```

筛选：

- 对象；
- 操作者；
- 季度；
- 变更集；
- 操作类型；
- AI参与；
- 高风险。

## 34.2 世界版本列表

```text
GET /api/v1/games/{gameId}/world-versions
```

## 34.3 世界版本差异

```text
GET /api/v1/games/{gameId}/world-versions/{fromVersion}/diff/{toVersion}
```

## 34.4 对象版本差异

```text
GET /api/v1/games/{gameId}/objects/{objectId}/versions/{fromVersion}/diff/{toVersion}
```

---

# 第三十五章 回滚API

## 35.1 回滚影响预览

```text
POST /api/v1/games/{gameId}/quarters/{quarterId}/rollback-preview
```

返回：

- 目标快照；
- 将失效的世界版本；
- 将回滚的变更集；
- 将失效的叙事；
- 受影响玩家；
- 受影响行动草稿；
- 风险。

## 35.2 执行回滚

```text
POST /api/v1/games/{gameId}/quarters/{quarterId}/rollback
```

请求：

```json
{
  "targetSnapshotId": "snapshot_xxx",
  "reason": "关键战斗结算规则错误",
  "confirmNarrativeInvalidation": true,
  "confirmPlayerDraftImpact": true
}
```

必须：

- 主持人权限；
- 二次确认；
- 幂等键；
- 审计记录。

---

# 第三十六章 文件与附件API

## 36.1 上传附件

```text
POST /api/v1/games/{gameId}/files
```

支持：

- 行动附件；
- 地图资源；
- 人物图片；
- 主持人资料；
- 报告附件。

## 36.2 获取文件

```text
GET /api/v1/games/{gameId}/files/{fileId}
```

返回授权下载或查看地址。

## 36.3 权限

文件权限必须继承或明确关联：

- 会话；
- 行动；
- 对象；
- 玩家；
- 主持人。

不得使用永久公开地址承载秘密附件。

---

# 第三十七章 分页与排序

## 37.1 游标分页

消息、审计和历史记录优先使用游标分页。

请求：

```text
?cursor=xxx&limit=50
```

## 37.2 页码分页

数量较小、变化不频繁的管理列表可以使用页码分页。

## 37.3 排序

排序字段必须来自允许列表。

不得允许客户端传入任意数据库字段名。

---

# 第三十八章 批量接口

## 38.1 批量读取

地图、对象摘要和结算页面应提供批量读取接口。

## 38.2 批量修改

批量修改必须先生成变更草稿。

示例：

```text
POST /api/v1/games/{gameId}/host/batch-edit-drafts
```

## 38.3 部分失败

正式批量变更若属于同一原子变更集，不允许部分成功。

非原子批量操作应返回每项结果。

---

# 第三十九章 接口权限矩阵

| 接口类别     |     玩家 |     主持人 |   系统任务 |        Agent |
| ------------ | -------: | ---------: | ---------: | -----------: |
| 玩家视图查询 |       是 |         是 |         是 |       按投影 |
| 真实世界查询 |       否 |         是 |     按权限 | 仅主持人任务 |
| 行动草稿     |     本国 |       全部 |         否 |   只生成建议 |
| 正式对象修改 |       否 | 通过变更集 | 通过变更集 |           否 |
| 创建变更草稿 |       否 |         是 |         是 |           是 |
| 批准变更集   |       否 |         是 |   受控流程 |           否 |
| 应用变更集   |       否 |         是 |   受控流程 |           否 |
| 战斗模拟     | 预览受限 |         是 |         是 |     生成输入 |
| 季度回滚     |       否 |         是 |         否 |           否 |
| 审计查询     |       否 |         是 |       受控 |           否 |

---

# 第四十章 接口安全要求

## 40.1 对象归属校验

所有对象ID必须验证其属于当前`gameId`。

## 40.2 字段白名单

修改接口只能操作后端允许的字段。

## 40.3 防止批量越权

批量查询和批量修改必须逐对象校验权限。

## 40.4 输入长度限制

自然语言、消息和附件必须设置合理限制。

## 40.5 速率限制

需要限制：

- 登录；
- 消息发送；
- 全局搜索；
- AI调用；
- 战斗批量模拟；
- 文件上传。

## 40.6 Agent输入安全

玩家文本必须作为数据字段传入，不得拼接为高优先级系统指令。

---

# 第四十一章 接口可观测性

## 41.1 请求记录

每次请求记录：

- 请求ID；
- 用户；
- 游戏；
- 接口；
- 状态码；
- 耗时；
- 世界版本；
- 错误代码。

## 41.2 敏感字段

日志不得记录：

- 密码；
  -访问令牌；
- 模型密钥；
- 完整秘密消息；
- 未脱敏的敏感上下文。

## 41.3 Agent追踪

一次Agent任务应能够串联：

- Agent任务ID；
- 模型调用；
- 工具调用；
- 生成变更集；
- 主持人批准；
- 世界版本。

---

# 第四十二章 首版最低实现范围

## 42.1 首版必须实现的外部API

- 用户与游戏；
- 当前季度；
- 地图视口；
- 地块和对象详情；
- 国家、城市、军队视图；
- 行动草稿与提交；
- 主持人行动审核；
- 事件回应；
- 消息与外交；
- 情报基础查询；
- 状态变更集；
- 冲突检查；
- 结算看板；
- 玩家视角预览；
- 世界版本；
- 审计；
- 回滚。

## 42.2 首版必须实现的Agent工具

- 对象搜索；
- 对象上下文；
- 相关历史摘要；
- 规则查询；
- 路径计算；
- 状态变更草稿；
- 基础冲突检查；
- 战斗输入准备。

## 42.3 首版可以简化

首版可以：

- 使用HTTP调用内部工具；
- 使用同进程函数实现部分工具；
- 暂不开放外部第三方API；
- 暂不提供通用Webhook；
- 暂不支持任意查询语言；
- 暂不支持完整API订阅；
- 暂不实现复杂GraphQL接口；
- 暂不为每种对象设计完全独立写接口。

---

# 第四十三章 接口验收标准

接口系统达到首版验收要求时，应满足：

1. 玩家接口无法返回主持人专属字段；
2. 主持人预览使用真实玩家投影；
3. 正式对象没有绕过变更集的直接写接口；
4. 幂等接口重复调用不会产生重复副作用；
5. 对象版本冲突不会被静默覆盖；
6. 世界版本冲突会返回明确错误；
7. Agent只能调用白名单工具；
8. Agent不能应用正式变更集；
9. 战斗模拟能够使用相同输入和随机种子复现；
10. 异步任务能够安全重试；
11. 所有对象ID均校验游戏归属；
12. 未知信息不会以0或空字符串返回；
13. 消息和附件具有服务端权限隔离；
14. 地图接口按视口和图层返回；
15. 错误响应具有稳定错误代码和追踪ID。

---

# 第四十四章 核心结论

SrilankaOL的接口体系必须围绕三个边界设计：

## 玩家与真实世界的边界

玩家调用的不是“真实对象查询接口”，而是经过权限与认知处理的玩家视图接口。

## AI与正式世界的边界

Agent可以：

- 查询；
- 分析；
- 调用确定性工具；
- 生成草稿。

Agent不能：

- 写数据库；
- 批准变更；
- 应用变更；
- 执行回滚。

## 候选结果与正式状态的边界

玩家行动、Agent输出、脚本结果和战斗模拟都必须先转换为：

> 状态变更草稿
> → 冲突检查
> → 主持人批准
> → 原子提交
> → 新世界版本

接口设计必须保证这些边界由后端强制执行，而不是依赖前端约定或提示词约束。
