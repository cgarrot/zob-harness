import type { ZobLiveEnvelope } from "./envelope.js";

export interface ZobPendingReplyResult {
  msgId: string;
  status: "completed" | "error" | "timeout";
  envelope?: ZobLiveEnvelope;
  errorHash?: string;
}

interface PendingReply {
  msgId: string;
  createdAt: number;
  resolve: (result: ZobPendingReplyResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ZobPendingReplies {
  private readonly pending = new Map<string, PendingReply>();
  private readonly completed = new Map<string, ZobPendingReplyResult>();

  wait(msgId: string, timeoutMs: number): Promise<ZobPendingReplyResult> {
    const completed = this.completed.get(msgId);
    if (completed) {
      this.completed.delete(msgId);
      return Promise.resolve(completed);
    }
    const boundedTimeout = Math.max(25, Math.min(30 * 60 * 1000, Math.floor(timeoutMs)));
    this.cancel(msgId);
    return new Promise<ZobPendingReplyResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(msgId);
        resolve({ msgId, status: "timeout" });
      }, boundedTimeout);
      timer.unref?.();
      this.pending.set(msgId, { msgId, createdAt: Date.now(), resolve, timer });
    });
  }

  complete(msgId: string, envelope: ZobLiveEnvelope): boolean {
    const result: ZobPendingReplyResult = { msgId, status: "completed", envelope };
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

  fail(msgId: string, errorHash: string): boolean {
    const result: ZobPendingReplyResult = { msgId, status: "error", errorHash };
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
    ];
  }
}
