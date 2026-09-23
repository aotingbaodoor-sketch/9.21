import { z } from "zod";
export const waRulesSchema = z
  .object({
    reassignmentPolicy: z.enum(["keep", "number_owner", "pool"]),
    reminderMinutes: z
      .array(z.number().int().min(1).max(10080))
      .min(1)
      .max(8)
      .transform((v) => [...new Set(v)].sort((a, b) => a - b)),
    version: z.number().int().positive(),
  })
  .strict();
export type WaRules = z.infer<typeof waRulesSchema>;
export const waSendSchema = z
  .object({
    conversationId: z.uuid(),
    text: z.string().trim().max(4096).default(""),
    templateId: z.string().max(200).optional(),
    templateParameters: z
      .array(z.string().trim().min(1).max(1000))
      .max(20)
      .default([]),
    replyToId: z.uuid().optional(),
    consentConfirmed: z.boolean().default(false),
  })
  .strict()
  .refine((v) => !!v.text || !!v.templateId, "请输入消息或选择模板");
export type WaAccount = {
  id: string;
  userId: string;
  userName: string;
  active: boolean;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  countryCallingCode: string;
  verifiedName: string;
  connectionStatus: string;
  connectedAt: string;
  lastWebhookAt: string | null;
  lastCheckedAt: string | null;
  subscriptionStatus: string;
  lastError: string | null;
  lastErrorCode: string | null;
  version: number;
  credentialConfigured: boolean;
};
export type WaMessage = {
  id: string;
  conversationId: string;
  customerId: string;
  whatsappMessageId: string | null;
  direction: string;
  messageType: string;
  textContent: string;
  messageTimestamp: string;
  deliveryStatus: string;
  mediaId: string | null;
  mediaMimeType: string | null;
  mediaFilename: string | null;
  mediaStatus: string | null;
  replyToMessageId: string | null;
  quotedText: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  content: Record<string, unknown>;
  ownerName: string;
};
export type WaConversation = {
  id: string;
  accountId: string;
  displayPhoneNumber: string;
  waId: string;
  userId: string;
  userName: string;
  lastInboundAt: string | null;
  conflict: boolean;
  canSend: boolean;
  windowOpen: boolean;
  connectionStatus: string;
};
export type WaSuggestion = {
  id: string;
  field: string;
  value: string;
  evidence: string;
  method: string;
  status: string;
};
export type WaTemplate = {
  id: string;
  accountId: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: Record<string, unknown>[];
  parameterCount: number;
  supported: boolean;
};
export type WaChat = {
  conversations: WaConversation[];
  messages: WaMessage[];
  suggestions: WaSuggestion[];
  page: number;
  pages: number;
  total: number;
  customerVersion: number;
  needsAssignment: boolean;
  assignments: {
    id: string;
    fromName: string | null;
    toName: string;
    reason: string;
    createdAt: string;
  }[];
};
export type WaSetupCheck = { id: string; label: string; configured: boolean; required: boolean; nextStep: string };
export type WaConfigView = {
  setupChecks?: WaSetupCheck[];
  messageEvidence?: { accountId: string; inboundCount: number; acceptedCount: number; deliveredCount: number; lastInboundAt: string | null; lastDeliveredAt: string | null }[];
  appId: string;
  graphVersion: string;
  signupConfigId: string;
  signupAvailable: boolean;
  appSecretConfigured: boolean;
  verifyTokenConfigured: boolean;
  encryptionKeyConfigured: boolean;
  callbackUrl: string;
  publicHttps: boolean;
  lastVerifiedAt: string | null;
  lastReceivedAt: string | null;
  signatureFailures: number;
  rules: WaRules;
  accounts: WaAccount[];
  alerts: { id: string; title: string; code: string; createdAt: string }[];
  events: {
    id: string;
    status: string;
    attempts: number;
    errorMessage: string | null;
    receivedAt: string;
    processedAt: string | null;
  }[];
};
export const suggestionLabels: Record<string, string> = {
  company: "公司名称",
  contact: "姓名",
  country: "国家",
  city: "城市",
  email: "邮箱",
  product: "感兴趣产品",
  quantity: "数量",
  specification: "规格",
  projectType: "项目类型",
  purchaseTime: "采购时间",
  inquiry: "需求摘要",
};
