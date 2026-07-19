import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { applyWheelSupervisorEvent } from "./reducer.js";
import { assertSafeSupervisorId, sha256Canonical } from "./canonical.js";
import {
  assertBodySafe,
  ensureDirectory,
  fileStamp,
  fsyncDirectory,
  readJson,
  sameStamp,
  writeAtomic,
  type FileStamp,
} from "./store-persistence.js";
import type {
  WheelSupervisorCheckpoint,
  WheelSupervisorEvent,
  WheelSupervisorEventKind,
  WheelSupervisorMissionState,
} from "./types.js";

const ZERO_HASH = "0".repeat(64);

interface WheelSupervisorOwnershipLock {
  schema: "wheel.zob.supervisor-ownership-lock.v1";
  missionId: string;
  ownerIdHash: string;
  ownershipEpoch: number;
  acquiredAt: string;
  expiresAt: string;
  bodyStored: false;
}

export interface WheelSupervisorOwnershipReceipt extends WheelSupervisorOwnershipLock {
  renewed: boolean;
  recoveredExpiredOwner: boolean;
}

export interface WheelSupervisorEventInput {
  mutationId: string;
  kind: WheelSupervisorEventKind;
  storyId?: string;
  attemptId?: string;
  payload?: Record<string, unknown>;
  occurredAt?: string;
  ownershipEpoch: number;
}

export interface WheelSupervisorCommitResult {
  state: WheelSupervisorMissionState;
  event: WheelSupervisorEvent;
  replayed: boolean;
}

function eventHashInput(event: Omit<WheelSupervisorEvent, "eventHash">): Omit<WheelSupervisorEvent, "eventHash"> {
  return event;
}

function verifyEvent(event: WheelSupervisorEvent, expectedSequence: number, expectedPreviousHash: string): void {
  if (event.schema !== "wheel.zob.supervisor-event.v1") throw new Error(`journal event ${expectedSequence} has unsupported schema`);
  if (event.sequence !== expectedSequence) throw new Error(`journal sequence gap at ${expectedSequence}`);
  if (event.previousHash !== expectedPreviousHash) throw new Error(`journal previousHash mismatch at ${expectedSequence}`);
  if (event.bodyStored !== false) throw new Error(`journal event ${expectedSequence} is not body-free`);
  assertBodySafe(event, `journal[${expectedSequence}]`);
  const { eventHash, ...withoutHash } = event;
  if (sha256Canonical(eventHashInput(withoutHash)) !== eventHash) throw new Error(`journal eventHash mismatch at ${expectedSequence}`);
}

function eventRequestHash(event: Pick<WheelSupervisorEvent, "kind" | "storyId" | "attemptId" | "payload" | "ownershipEpoch">): string {
  return sha256Canonical({
    kind: event.kind,
    storyId: event.storyId,
    attemptId: event.attemptId,
    payload: event.payload,
    ownershipEpoch: event.ownershipEpoch,
  });
}

export interface WheelSupervisorStoreOptions {
  checkpointEvery?: number;
}

export class FileWheelSupervisorStore {
  readonly stateDirectory: string;
  readonly journalPath: string;
  readonly checkpointPath: string;
  readonly ownershipLockPath: string;
  readonly checkpointEvery: number;
  private cachedEvents?: WheelSupervisorEvent[];
  private cachedState?: WheelSupervisorMissionState;
  private cachedJournalStamp?: FileStamp;
  private cachedCheckpointStamp?: FileStamp;

  constructor(stateDirectory: string, options: WheelSupervisorStoreOptions = {}) {
    this.stateDirectory = resolve(stateDirectory);
    this.journalPath = join(this.stateDirectory, "journal.jsonl");
    this.checkpointPath = join(this.stateDirectory, "checkpoint.json");
    this.ownershipLockPath = join(this.stateDirectory, "owner.lock.json");
    this.checkpointEvery = options.checkpointEvery ?? 1;
    if (!Number.isSafeInteger(this.checkpointEvery) || this.checkpointEvery < 1) throw new Error("checkpointEvery must be a positive safe integer");
  }

  private appendJournalEvent(event: WheelSupervisorEvent): void {
    ensureDirectory(this.stateDirectory);
    const descriptor = openSync(this.journalPath, "a", 0o600);
    try {
      writeSync(descriptor, `${JSON.stringify(event)}\n`, undefined, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    fsyncDirectory(this.stateDirectory);
  }

  private loadEventsInternal(): WheelSupervisorEvent[] {
    const currentStamp = fileStamp(this.journalPath);
    if (this.cachedEvents && sameStamp(currentStamp, this.cachedJournalStamp)) return this.cachedEvents;
    if (!currentStamp) {
      this.cachedEvents = [];
      this.cachedJournalStamp = undefined;
      this.cachedState = undefined;
      return this.cachedEvents;
    }
    const raw = readFileSync(this.journalPath, "utf8");
    if (raw.length > 0 && !raw.endsWith("\n")) throw new Error("supervisor journal has a truncated tail");
    const events = raw.split("\n").filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line) as WheelSupervisorEvent;
      } catch {
        throw new Error(`supervisor journal line ${index + 1} is invalid JSON`);
      }
    });
    let previousHash = ZERO_HASH;
    const mutations = new Set<string>();
    events.forEach((event, index) => {
      verifyEvent(event, index + 1, previousHash);
      if (mutations.has(event.mutationId)) throw new Error(`duplicate mutationId ${event.mutationId} in supervisor journal`);
      mutations.add(event.mutationId);
      previousHash = event.eventHash;
    });
    this.cachedEvents = events;
    this.cachedJournalStamp = currentStamp;
    this.cachedState = undefined;
    return events;
  }

  loadEvents(): WheelSupervisorEvent[] {
    return structuredClone(this.loadEventsInternal());
  }

  loadCheckpoint(): WheelSupervisorCheckpoint | undefined {
    if (!existsSync(this.checkpointPath)) return undefined;
    const checkpoint = readJson<WheelSupervisorCheckpoint>(this.checkpointPath);
    if (checkpoint.schema !== "wheel.zob.supervisor-checkpoint.v1") throw new Error("supervisor checkpoint schema is unsupported");
    if (checkpoint.bodyStored !== false) throw new Error("supervisor checkpoint is not body-free");
    assertBodySafe(checkpoint, "checkpoint");
    if (sha256Canonical(checkpoint.state) !== checkpoint.projectionHash) throw new Error("supervisor checkpoint projection hash mismatch");
    if (checkpoint.state.journalSequence !== checkpoint.sequence || checkpoint.state.journalHeadHash !== checkpoint.journalHeadHash) {
      throw new Error("supervisor checkpoint lineage does not match its projection");
    }
    return checkpoint;
  }

  load(): WheelSupervisorMissionState | undefined {
    const journalStamp = fileStamp(this.journalPath);
    const checkpointStamp = fileStamp(this.checkpointPath);
    if (
      this.cachedState
      && sameStamp(journalStamp, this.cachedJournalStamp)
      && sameStamp(checkpointStamp, this.cachedCheckpointStamp)
    ) return structuredClone(this.cachedState);
    const events = this.loadEventsInternal();
    const checkpoint = this.loadCheckpoint();
    let state = checkpoint ? structuredClone(checkpoint.state) : undefined;
    const startIndex = checkpoint?.sequence ?? 0;
    if (checkpoint) {
      const event = events[checkpoint.sequence - 1];
      if (!event || event.eventHash !== checkpoint.journalHeadHash) throw new Error("checkpoint journal head is missing or mismatched");
    }
    for (let index = startIndex; index < events.length; index += 1) state = applyWheelSupervisorEvent(state, events[index]);
    this.cachedState = state ? structuredClone(state) : undefined;
    this.cachedJournalStamp = fileStamp(this.journalPath);
    this.cachedCheckpointStamp = fileStamp(this.checkpointPath);
    return state ? structuredClone(state) : undefined;
  }

  writeCheckpoint(state: WheelSupervisorMissionState, writtenAt = new Date().toISOString()): WheelSupervisorCheckpoint {
    assertBodySafe(state, "state");
    const checkpoint: WheelSupervisorCheckpoint = {
      schema: "wheel.zob.supervisor-checkpoint.v1",
      missionId: state.missionId,
      sequence: state.journalSequence,
      journalHeadHash: state.journalHeadHash,
      projectionHash: sha256Canonical(state),
      ownershipEpoch: state.ownershipEpoch,
      writtenAt,
      state: structuredClone(state),
      bodyStored: false,
    };
    writeAtomic(this.checkpointPath, checkpoint);
    this.cachedState = structuredClone(state);
    this.cachedJournalStamp = fileStamp(this.journalPath);
    this.cachedCheckpointStamp = fileStamp(this.checkpointPath);
    return checkpoint;
  }

  initialize(initialState: WheelSupervisorMissionState, input: { mutationId: string; occurredAt?: string }): WheelSupervisorCommitResult {
    assertSafeSupervisorId(initialState.missionId, "missionId");
    if (this.loadEvents().length > 0 || existsSync(this.checkpointPath)) throw new Error("supervisor state directory is already initialized");
    const occurredAt = input.occurredAt ?? initialState.admittedAt;
    return this.commitFrom(undefined, {
      mutationId: input.mutationId,
      kind: "mission-admitted",
      payload: { initialState },
      occurredAt,
      ownershipEpoch: initialState.ownershipEpoch,
    });
  }

  commit(input: WheelSupervisorEventInput, options: { crashAfterJournalAppend?: boolean } = {}): WheelSupervisorCommitResult {
    const current = this.load();
    if (!current) throw new Error("supervisor mission is not initialized");
    return this.commitFrom(current, input, options);
  }

  private commitFrom(
    current: WheelSupervisorMissionState | undefined,
    input: WheelSupervisorEventInput,
    options: { crashAfterJournalAppend?: boolean } = {},
  ): WheelSupervisorCommitResult {
    assertSafeSupervisorId(input.mutationId, "mutationId");
    assertBodySafe(input.payload ?? {}, "event.payload");
    const events = this.loadEventsInternal();
    const replay = events.find((event) => event.mutationId === input.mutationId);
    if (replay) {
      const requestedHash = eventRequestHash({ ...input, payload: input.payload ?? {} });
      if (eventRequestHash(replay) !== requestedHash) throw new Error(`mutationId ${input.mutationId} payload conflict`);
      const state = this.load();
      if (!state) throw new Error("replayed mutation has no projection");
      return { state, event: replay, replayed: true };
    }
    if (current && input.kind !== "ownership-taken" && input.ownershipEpoch !== current.ownershipEpoch) {
      throw new Error(`ownership epoch ${input.ownershipEpoch} does not match current epoch ${current.ownershipEpoch}`);
    }
    if (current && input.kind === "ownership-taken" && input.ownershipEpoch <= current.ownershipEpoch) {
      throw new Error("ownership-taken requires a newer ownership epoch");
    }
    const previous = events.at(-1);
    const withoutHash: Omit<WheelSupervisorEvent, "eventHash"> = {
      schema: "wheel.zob.supervisor-event.v1",
      missionId: current?.missionId ?? (input.payload?.initialState as WheelSupervisorMissionState | undefined)?.missionId ?? "",
      sequence: events.length + 1,
      previousHash: previous?.eventHash ?? ZERO_HASH,
      mutationId: input.mutationId,
      kind: input.kind,
      storyId: input.storyId,
      attemptId: input.attemptId,
      payload: input.payload ?? {},
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      ownershipEpoch: input.ownershipEpoch,
      bodyStored: false,
    };
    if (!withoutHash.missionId) throw new Error("supervisor event missionId is missing");
    const event: WheelSupervisorEvent = { ...withoutHash, eventHash: sha256Canonical(eventHashInput(withoutHash)) };
    this.appendJournalEvent(event);
    this.cachedEvents = [...events, event];
    this.cachedJournalStamp = fileStamp(this.journalPath);
    this.cachedState = undefined;
    const state = applyWheelSupervisorEvent(current, event);
    if (options.crashAfterJournalAppend) throw new Error("simulated_crash_after_journal_append");
    if (event.sequence % this.checkpointEvery === 0 || event.kind === "mission-completed" || event.kind === "mission-failed" || event.kind === "mission-needs-human") {
      this.writeCheckpoint(state, event.occurredAt);
    } else {
      this.cachedState = structuredClone(state);
      this.cachedCheckpointStamp = fileStamp(this.checkpointPath);
    }
    return { state, event, replayed: false };
  }

  acquireOwnership(input: {
    missionId: string;
    ownerIdHash: string;
    now?: string;
    leaseMs: number;
  }): WheelSupervisorOwnershipReceipt {
    assertSafeSupervisorId(input.missionId, "missionId");
    if (!/^[a-f0-9]{64}$/.test(input.ownerIdHash)) throw new Error("ownerIdHash must be a full sha256");
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1) throw new Error("leaseMs must be a positive integer");
    ensureDirectory(this.stateDirectory);
    const now = input.now ?? new Date().toISOString();
    const nowMs = Date.parse(now);
    if (Number.isNaN(nowMs)) throw new Error("ownership time is invalid");
    const currentState = this.load();
    let recoveredExpiredOwner = false;
    let existing: WheelSupervisorOwnershipLock | undefined;
    if (existsSync(this.ownershipLockPath)) {
      existing = readJson<WheelSupervisorOwnershipLock>(this.ownershipLockPath);
      if (existing.missionId !== input.missionId) throw new Error("ownership lock missionId mismatch");
      if (Date.parse(existing.expiresAt) > nowMs && existing.ownerIdHash !== input.ownerIdHash) throw new Error("mission ownership is held by another live owner");
      if (Date.parse(existing.expiresAt) > nowMs && existing.ownerIdHash === input.ownerIdHash) {
        const renewed: WheelSupervisorOwnershipReceipt = {
          ...existing,
          expiresAt: new Date(nowMs + input.leaseMs).toISOString(),
          renewed: true,
          recoveredExpiredOwner: false,
        };
        const { renewed: _renewed, recoveredExpiredOwner: _recovered, ...lock } = renewed;
        writeAtomic(this.ownershipLockPath, lock);
        return renewed;
      }
      const stalePath = `${this.ownershipLockPath}.stale.${sha256Canonical(existing).slice(0, 16)}.json`;
      renameSync(this.ownershipLockPath, stalePath);
      recoveredExpiredOwner = true;
    }
    const epoch = Math.max(currentState?.ownershipEpoch ?? 0, existing?.ownershipEpoch ?? 0) + 1;
    const lock: WheelSupervisorOwnershipLock = {
      schema: "wheel.zob.supervisor-ownership-lock.v1",
      missionId: input.missionId,
      ownerIdHash: input.ownerIdHash,
      ownershipEpoch: epoch,
      acquiredAt: now,
      expiresAt: new Date(nowMs + input.leaseMs).toISOString(),
      bodyStored: false,
    };
    const descriptor = openSync(this.ownershipLockPath, "wx", 0o600);
    try {
      writeSync(descriptor, `${JSON.stringify(lock, null, 2)}\n`, undefined, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    fsyncDirectory(this.stateDirectory);
    return { ...lock, renewed: false, recoveredExpiredOwner };
  }

  releaseOwnership(input: { ownerIdHash: string; ownershipEpoch: number; releasedAt?: string }): string {
    if (!existsSync(this.ownershipLockPath)) throw new Error("ownership lock is missing");
    const lock = readJson<WheelSupervisorOwnershipLock>(this.ownershipLockPath);
    if (lock.ownerIdHash !== input.ownerIdHash || lock.ownershipEpoch !== input.ownershipEpoch) throw new Error("ownership release does not match current owner and epoch");
    const receipt = {
      schema: "wheel.zob.supervisor-ownership-release.v1",
      missionId: lock.missionId,
      ownerIdHash: lock.ownerIdHash,
      ownershipEpoch: lock.ownershipEpoch,
      releasedAt: input.releasedAt ?? new Date().toISOString(),
      bodyStored: false,
    };
    const releasedPath = `${this.ownershipLockPath}.released.${sha256Canonical(receipt).slice(0, 16)}.json`;
    writeAtomic(releasedPath, receipt);
    renameSync(this.ownershipLockPath, `${releasedPath}.lock`);
    fsyncDirectory(this.stateDirectory);
    return releasedPath;
  }
}
