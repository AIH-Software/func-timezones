export interface MessageContext {
  text: string;
  postedAtUtc: string;
  senderTimezone: string;
}

export interface TimeEndpoint {
  local: string;
  utc: string;
}

export interface ExtractedMention {
  text: string;
  timezone: string;
  timezoneBasis: "explicit" | "sender";
  dateBasis: "explicit" | "relative" | "message_date";
  start: TimeEndpoint;
  end: TimeEndpoint | null;
}

export interface Extraction {
  mentions: ExtractedMention[];
  ambiguous: Array<{ text: string; reason: string }>;
}

export interface ResolvedMention extends ExtractedMention {
  startUnix: number;
  endUnix: number | null;
}

export interface ValidationResult {
  mentions: ResolvedMention[];
  rejected: Array<{ text: string; reason: string }>;
}

export type ProviderName = "haiku" | "luna";

export interface ExtractionProvider {
  name: ProviderName;
  extract(context: MessageContext): Promise<unknown>;
}

export interface SourceMessage {
  team: string;
  channel: string;
  ts: string;
  revision?: number;
  user: string;
  text: string;
  threadTs?: string;
  requestedBy?: string;
}

export interface SlackUser {
  id: string;
  tz?: string;
  is_bot?: boolean;
  deleted?: boolean;
  is_app_user?: boolean;
}

export interface EphemeralNotice {
  channel: string;
  user: string;
  text: string;
  blocks: Array<Record<string, unknown>>;
  thread_ts?: string;
}
