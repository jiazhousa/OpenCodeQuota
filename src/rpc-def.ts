// quota 插件 RPC 契约（server 注册 / CLI 底层 call 共用常量）。
// 手写定义形状（2.0.16 实证 register 接受）；CLI 侧经 client.rpc.call({rpcID, method, input}) 调用（官方契约，无需 Definition 对象）。
export const QUOTA_PLUGIN_ID = "opencode-channel-quota";
export const QUOTA_RPC_ID = "opencode-quota";
export const QUOTA_RPC_UPDATED_TYPE = `rpc.${QUOTA_RPC_ID}.updated`;

// ViewState 是纯 JSON 脱敏快照；schema 宽松守形（channels 数组 + now 数字），字段级校验由消费端 sanitizedView 防御。
const VIEW_SCHEMA = {
  type: "object",
  properties: {
    channels: { type: "array" },
    localStatus: { type: "object" },
    now: { type: "number" },
  },
  required: ["channels", "now"],
  additionalProperties: true,
} as const;

export const QUOTA_RPC_DEF = {
  id: QUOTA_RPC_ID,
  methods: {
    view: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: VIEW_SCHEMA,
    },
  },
  events: {
    updated: { schema: VIEW_SCHEMA },
  },
} as const;
