// واجهة موحدة لكل مزود — أي خطأ يُرمى كـ ProviderError ليُصنَّف تلقائيًا
import type { ApiKeyRow } from "../keys-db";

export interface GenInput {
  prompt: string;
  imageUrl?: string;
  aspectRatio?: string;
  resolution?: string;
  background?: string;
  outputFormat?: string;
  enableAudio?: boolean;
  duration?: number;
}

export interface ProviderTaskHandle {
  providerTaskId: string;
}

export interface ProviderCheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number; // تقدير 0..100 إن وفره المزود
}

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو وبعض الصور): تعيد providerTaskId
  createTask(key: ApiKeyRow, providerModel: string, input: GenInput): Promise<ProviderTaskHandle>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
  createImageSync?(key: ApiKeyRow, input: GenInput): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(key: ApiKeyRow, providerTaskId: string): Promise<ProviderCheckResult>;
}
