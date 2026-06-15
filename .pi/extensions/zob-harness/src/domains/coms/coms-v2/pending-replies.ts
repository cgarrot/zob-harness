import type { ZobLiveEnvelope } from "./envelope.js";

export interface ZobPendingReplyResult {
  msgId: string;
  status: "completed" | "error" | "timeout" | "required_response_expired";
  envelope?: ZobLiveEnvelope;
  errorHash?: string;
}

interface PendingReply {
  msgId: string;
  createdAt: number;
  requireResponse: boolean;
  resolve: (result: ZobPendingReplyResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ZobPendingReplies {
  private readonly pending = new Map<string, PendingReply>();
  private readonly completed = new Map<string, ZobPendingReplyResult>();
  private readonly expired = new Set<string>();

  wait(msgId: string, timeoutMs: number, options: { requireResponse?: boolean } = {}): Promise<ZobPendingReplyResult> {
    const completed = this.completed.get(msgId);
    if (completed) {
      this.completed.delete(msgId);
      if (options.requireResponse === true && completed.status === "completed" && completed.envelope?.replyToMsgId !== msgId) {
        this.expired.add(msgId);
        return Promise.resolve({ msgId, status: "required_response_expired" });
      }
      return Promise.resolve(completed);
    }
    const boundedTimeout = Math.max(25, Math.min(30 * 60 * 1000, Math.floor(timeoutMs)));
    this.cancel(msgId);
    return new Promise<ZobPendingReplyResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(msgId);
        if (options.requireResponse === true) this.expired.add(msgId);
        resolve({ msgId, status: options.requireResponse === true ? "required_response_expired" : "timeout" });
      }, boundedTimeout);
      timer.unref?.();
      this.pending.set(msgId, { msgId, createdAt: Date.now(), requireResponse: options.requireResponse === true, resolve, timer });
    });
  }

  complete(msgId: string, envelope: ZobLiveEnvelope): boolean {
    if (this.expired.has(msgId)) return false;
    const item = this.pending.get(msgId);
    if (item?.requireResponse && envelope.replyToMsgId !== msgId) return false;
    if (envelope.replyToMsgId !== undefined && envelope.replyToMsgId !== msgId) return false;
    const result: ZobPendingReplyResult = { msgId, status: "completed", envelope };
    if (!item) {
      this.completed.set(msgId, result);
      return false;
    }
    clearTimeout(item.timer);
    this.pending.delete(msgId);
    this.expired.delete(msgId);
    item.resolve(result);
    return true;
  }

  fail(msgId: string, errorHash: string): boolean {
    const result: ZobPendingReplyResult = { msgId, status: "error", errorHash };
    const item = this.pending.get(msgId);
    if (!item) {
      this.completed.set(msgId, result);
      return false;
    }
    clearTimeout(item.timer);
    this.pending.delete(msgId);
    this.expired.delete(msgId);
    item.resolve(result);
    return true;
  }

  expire(msgId: string, errorHash?: string): boolean {
    const result: ZobPendingReplyResult = { msgId, status: "required_response_expired", errorHash };
    this.expired.add(msgId);
    const item = this.pending.get(msgId);
    if (!item) {
      this.completed.set(msgId, result);
      return false;
    }
    clearTimeout(item.timer);
    this.pending.delete(msgId);
    item.resolve(result);
    return true;
  }

  cancel(msgId: string): boolean {
    this.expired.delete(msgId);
    const item = this.pending.get(msgId);
    if (!item) return false;
    clearTimeout(item.timer);
    this.pending.delete(msgId);
    return true;
  }

  snapshot(): Array<Record<string, unknown>> {
    const now = Date.now();
    return [
      ...[...this.pending.values()].map((item) => ({ msgId: item.msgId, ageMs: now - item.createdAt, status: "pending", bodyStored: false })),
      ...[...this.completed.values()].map((item) => ({ msgId: item.msgId, status: item.status, bodyStored: false })),
      ...[...this.expired.values()].map((msgId) => ({ msgId, status: "required_response_expired", bodyStored: false })),
    ];
  }
}
