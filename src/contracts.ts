import type { ResolvedMention, SourceMessage } from "./types.js";

export interface AppConfig {
  botToken: string; signingSecret: string; teamId: string;
  anthropicKey?: string; openaiKey?: string; anthropicModel: string; openaiModel: string;
  timeoutMs: number; renderMode: "slack" | "profile"; includeSender: boolean;
  maxMessageAgeSeconds: number; allowedChannels: Set<string>;
}

export interface DeliveryTask {
  kind: "delivery"; id: string; source: SourceMessage; recipient: string;
  mentions: ResolvedMention[]; receivedAt: number; permalink?: string;
}

export interface ParseTask {
  kind: "parse"; id: string; source: SourceMessage; receivedAt: number;
}

export interface ParsedJob {
  mentions: ResolvedMention[]; recipients: string[]; permalink?: string;
}

export interface JobStore {
  invalidate(channel: string, ts: string, revision?: number, deleted?: boolean): Promise<void>;
  isInvalidated(channel: string, ts: string, since?: number, revision?: number): Promise<boolean>;
  getParsed(id: string): Promise<ParsedJob | undefined>;
  saveParsed(id: string, value: ParsedJob): Promise<void>;
  claimDelivery(id: string): Promise<boolean>;
  releaseDelivery(id: string): Promise<void>;
  getDeliveryCooldown(): Promise<number>;
  setDeliveryCooldown(until: number): Promise<void>;
}

export interface TaskQueue {
  parse(task: ParseTask): Promise<void>;
  deliver(task: DeliveryTask): Promise<void>;
}
