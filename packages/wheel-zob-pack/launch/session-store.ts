import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

import { assertSafeSupervisorId, sha256Canonical, sha256Text } from "../supervisor/canonical.js";
import { assertBodySafe, ensureDirectory, fsyncDirectory, readJson, writeAtomic } from "../supervisor/store-persistence.js";
import {
  loadWheelLocalMachineLaunchPlan,
  resolveWheelLocalLaunchDirectory,
  wheelLocalMachineStartConfirmation,
} from "./local-machine.js";
import type {
  WheelLocalMachineLaunchClaim,
  WheelLocalMachineLaunchEvent,
  WheelLocalMachineLaunchEventKind,
  WheelLocalMachineLaunchStatus,
  WheelLocalMachineLaunchStatusReport,
  WheelLocalWorkspaceInspection,
} from "./types.js";

const ZERO_HASH = "0".repeat(64);
const SHA64 = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DEFAULT_LEASE_MS = 12 * 60 * 60 * 1_000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1_000;
const FORBIDDEN_EVIDENCE_REF = /(^|\/)(?:\.env(?:\.|$)|\.pi\/(?:sessions|agent-sessions)(?:\/|$)|secrets?(?:\/|$)|credentials?(?:\/|$))/i;

interface WheelLocalMachineOwnershipLock {
  schema: "wheel.zob.local-machine-ownership-lock.v1";
  launchId: string;
  planHash: string;
  machineId: string;
  assignmentHash: string;
  ownerIdHash: string;
  sessionIdHash: string;
  workspaceRootHash: string;
  ownershipEpoch: number;
  acquiredAt: string;
  expiresAt: string;
  bodyStored: false;
}

interface WheelLocalMachineCheckpoint {
  schema: "wheel.zob.local-machine-launch-checkpoint.v1";
  launchId: string;
  machineId: string;
  eventCount: number;
  journalHeadHash: string;
  claimHash: string;
  claim: WheelLocalMachineLaunchClaim;
  writtenAt: string;
  bodyStored: false;
}

function safeEvidenceRef(value: string): boolean {
  return value.length > 0
    && !value.startsWith("/")
    && !value.split(/[\\/]+/).includes("..")
    && !FORBIDDEN_EVIDENCE_REF.test(value.split("\\").join("/"));
}

function validateOwnershipLock(lock: WheelLocalMachineOwnershipLock): void {
  assertBodySafe(lock, "ownershipLock");
  if (lock.schema !== "wheel.zob.local-machine-ownership-lock.v1") throw new Error("local machine ownership lock schema is invalid");
  if (!SHA64.test(lock.planHash) || !SHA64.test(lock.assignmentHash) || !SHA64.test(lock.ownerIdHash) || !SHA64.test(lock.sessionIdHash) || !SHA64.test(lock.workspaceRootHash)) {
    throw new Error("local machine ownership lock hashes are invalid");
  }
  if (!Number.isSafeInteger(lock.ownershipEpoch) || lock.ownershipEpoch < 1) throw new Error("local machine ownership lock epoch is invalid");
  if (!Number.isFinite(Date.parse(lock.acquiredAt)) || !Number.isFinite(Date.parse(lock.expiresAt)) || Date.parse(lock.expiresAt) <= Date.parse(lock.acquiredAt)) {
    throw new Error("local machine ownership lock timestamps are invalid");
  }
  if (lock.bodyStored !== false) throw new Error("local machine ownership lock must be body-free");
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function inspectWheelLocalWorkspace(repoRoot: string): WheelLocalWorkspaceInspection {
  const repositoryRoot = realpathSync(git(repoRoot, ["rev-parse", "--show-toplevel"]));
  const requestedRoot = realpathSync(resolve(repoRoot));
  if (repositoryRoot !== requestedRoot) throw new Error("local machine start must run from the repository worktree root");
  const gitDirectory = realpathSync(git(repositoryRoot, ["rev-parse", "--absolute-git-dir"]));
  const commonRaw = git(repositoryRoot, ["rev-parse", "--git-common-dir"]);
  const commonDirectory = realpathSync(resolve(repositoryRoot, commonRaw));
  let branchName: string;
  try {
    branchName = git(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    throw new Error("local machine workspace must be on a named branch, not detached HEAD");
  }
  const headSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
  if (!GIT_OBJECT_ID.test(headSha)) throw new Error("local machine workspace HEAD is invalid");
  const clean = git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]).length === 0;
  return {
    schema: "wheel.zob.local-workspace-inspection.v1",
    repositoryRoot,
    workspaceRootHash: sha256Text(repositoryRoot),
    headSha,
    branchName,
    linkedWorktree: gitDirectory !== commonDirectory,
    clean,
    bodyStored: false,
  };
}

function eventPayload(event: WheelLocalMachineLaunchEvent): Omit<WheelLocalMachineLaunchEvent, "eventHash"> {
  const { eventHash: _eventHash, ...payload } = event;
  return payload;
}

function requestHash(kind: WheelLocalMachineLaunchEventKind, claim: WheelLocalMachineLaunchClaim): string {
  return sha256Canonical({ kind, claim });
}

function statusForKind(kind: WheelLocalMachineLaunchEventKind): WheelLocalMachineLaunchStatus {
  if (kind === "machine-claimed") return "claimed";
  if (kind === "machine-started") return "started";
  if (kind === "machine-running") return "running";
  if (kind === "machine-recovered") return "started";
  if (kind === "machine-local-ready") return "local-ready";
  if (kind === "machine-handoff-candidate") return "handoff-candidate";
  return "blocked";
}

function transitionAllowed(from: WheelLocalMachineLaunchStatus, to: WheelLocalMachineLaunchStatus): boolean {
  return (
    (from === "claimed" && (to === "started" || to === "blocked"))
    || (from === "started" && (to === "running" || to === "blocked"))
    || (from === "running" && (to === "local-ready" || to === "blocked"))
    || (from === "blocked" && to === "running")
    || (from === "local-ready" && to === "handoff-candidate")
  );
}

function eventKindForStatus(status: Exclude<WheelLocalMachineLaunchStatus, "claimed">): WheelLocalMachineLaunchEventKind {
  if (status === "started") return "machine-started";
  if (status === "running") return "machine-running";
  if (status === "local-ready") return "machine-local-ready";
  if (status === "handoff-candidate") return "machine-handoff-candidate";
  return "machine-blocked";
}

export function assertWheelLocalMachineLaunchClaim(claim: WheelLocalMachineLaunchClaim): void {
  assertBodySafe(claim, "claim");
  for (const [label, value] of [
    ["planHash", claim.planHash],
    ["assignmentHash", claim.assignmentHash],
    ["ownerIdHash", claim.ownerIdHash],
    ["sessionIdHash", claim.sessionIdHash],
    ["workspaceRootHash", claim.workspaceRootHash],
    ["confirmationHash", claim.confirmationHash],
  ] as const) if (!SHA64.test(value)) throw new Error(`${label} must be a full lowercase sha256`);
  if (!GIT_OBJECT_ID.test(claim.workspaceHeadSha)) throw new Error("workspaceHeadSha must be a git object id");
  if (claim.linkedWorktree !== true || claim.cleanAtInitialClaim !== true) throw new Error("claim must prove a clean linked worktree at initial claim");
  if (!Number.isSafeInteger(claim.ownershipEpoch) || claim.ownershipEpoch < 1) throw new Error("ownershipEpoch must be a positive safe integer");
  const claimedAt = Date.parse(claim.claimedAt);
  const updatedAt = Date.parse(claim.updatedAt);
  const leaseExpiresAt = Date.parse(claim.leaseExpiresAt);
  if (!Number.isFinite(claimedAt) || !Number.isFinite(updatedAt) || !Number.isFinite(leaseExpiresAt) || updatedAt < claimedAt || leaseExpiresAt <= claimedAt) {
    throw new Error("claim timestamps are invalid");
  }
  if (claim.commitEnabled !== false || claim.pushEnabled !== false || claim.githubEffectsEnabled !== false || claim.bodyStored !== false) {
    throw new Error("claim must keep commit, push, GitHub, and durable bodies disabled");
  }
  if (
    claim.evidenceRefs.length !== claim.evidenceHashes.length
    || !claim.evidenceRefs.every(safeEvidenceRef)
    || !claim.evidenceHashes.every((hash) => SHA64.test(hash))
  ) throw new Error("claim evidence refs and hashes must be safe and align one-for-one");
  if (claim.zagentPresenceReceiptHash !== undefined && !SHA64.test(claim.zagentPresenceReceiptHash)) throw new Error("zagentPresenceReceiptHash must be a full lowercase sha256");
  if (claim.blockerHash !== undefined && !SHA64.test(claim.blockerHash)) throw new Error("blockerHash must be a full lowercase sha256");
  if (claim.status === "blocked" && claim.blockerHash === undefined) throw new Error("blocked claim requires blockerHash");
}

export function wheelLocalMachineRecoveryConfirmation(input: {
  launchId: string;
  machineId: string;
  planHash: string;
  ownershipEpoch: number;
}): string {
  return `RECOVER WHEEL LOCAL ${input.launchId} MACHINE ${input.machineId} PLAN ${input.planHash} EPOCH ${input.ownershipEpoch}`;
}

export class FileWheelLocalMachineLaunchStore {
  readonly repoRoot: string;
  readonly launchId: string;
  readonly machineId: string;
  readonly machineDirectory: string;
  readonly journalPath: string;
  readonly checkpointPath: string;
  readonly ownershipLockPath: string;

  constructor(repoRoot: string, launchId: string, machineId: string) {
    assertSafeSupervisorId(launchId, "launchId");
    assertSafeSupervisorId(machineId, "machineId");
    this.repoRoot = resolve(repoRoot);
    this.launchId = launchId;
    this.machineId = machineId;
    this.machineDirectory = resolve(resolveWheelLocalLaunchDirectory(this.repoRoot, launchId), "machines", machineId);
    this.journalPath = join(this.machineDirectory, "journal.jsonl");
    this.checkpointPath = join(this.machineDirectory, "checkpoint.json");
    this.ownershipLockPath = join(this.machineDirectory, "owner.lock.json");
  }

  private assertCheckpointCurrent(events = this.loadEvents()): void {
    if (events.length === 0) {
      if (existsSync(this.checkpointPath)) throw new Error("local launch checkpoint exists without a journal; explicit repair or quarantine is required");
      return;
    }
    if (!existsSync(this.checkpointPath)) throw new Error("local launch checkpoint is missing; run explicit checkpoint repair before mutation");
    const checkpoint = readJson<WheelLocalMachineCheckpoint>(this.checkpointPath);
    assertBodySafe(checkpoint, "checkpoint");
    const latest = events.at(-1) as WheelLocalMachineLaunchEvent;
    if (
      checkpoint.schema !== "wheel.zob.local-machine-launch-checkpoint.v1"
      || checkpoint.launchId !== this.launchId
      || checkpoint.machineId !== this.machineId
      || checkpoint.eventCount !== events.length
      || checkpoint.journalHeadHash !== latest.eventHash
      || checkpoint.claimHash !== sha256Canonical(latest.claim)
      || sha256Canonical(checkpoint.claim) !== checkpoint.claimHash
    ) throw new Error("local launch checkpoint is stale or corrupted; run explicit checkpoint repair before mutation");
  }

  private append(event: WheelLocalMachineLaunchEvent, options: { crashAfterJournalAppend?: boolean } = {}): { claim: WheelLocalMachineLaunchClaim; replayed: boolean } {
    const events = this.loadEvents();
    this.assertCheckpointCurrent(events);
    const replay = events.find((item) => item.mutationId === event.mutationId);
    if (replay) {
      if (requestHash(replay.kind, replay.claim) !== requestHash(event.kind, event.claim)) throw new Error(`mutationId ${event.mutationId} payload conflict`);
      return { claim: structuredClone(replay.claim), replayed: true };
    }
    const previous = events.at(-1);
    const withoutHash: Omit<WheelLocalMachineLaunchEvent, "eventHash"> = {
      ...eventPayload(event),
      sequence: events.length + 1,
      previousHash: previous?.eventHash ?? ZERO_HASH,
    };
    const committed: WheelLocalMachineLaunchEvent = { ...withoutHash, eventHash: sha256Canonical(withoutHash) };
    ensureDirectory(this.machineDirectory);
    const descriptor = openSync(this.journalPath, "a", 0o600);
    try {
      writeSync(descriptor, `${JSON.stringify(committed)}\n`, undefined, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    fsyncDirectory(this.machineDirectory);
    if (options.crashAfterJournalAppend) throw new Error("simulated_local_launch_crash_after_journal_append");
    this.writeCheckpoint(committed.claim, committed.sequence, committed.eventHash, committed.occurredAt);
    return { claim: structuredClone(committed.claim), replayed: false };
  }

  private writeCheckpoint(claim: WheelLocalMachineLaunchClaim, eventCount: number, journalHeadHash: string, writtenAt: string): void {
    const checkpoint: WheelLocalMachineCheckpoint = {
      schema: "wheel.zob.local-machine-launch-checkpoint.v1",
      launchId: this.launchId,
      machineId: this.machineId,
      eventCount,
      journalHeadHash,
      claimHash: sha256Canonical(claim),
      claim: structuredClone(claim),
      writtenAt,
      bodyStored: false,
    };
    writeAtomic(this.checkpointPath, checkpoint);
  }

  loadEvents(): WheelLocalMachineLaunchEvent[] {
    if (!existsSync(this.journalPath)) return [];
    const raw = readFileSync(this.journalPath, "utf8");
    if (raw.length > 0 && !raw.endsWith("\n")) throw new Error("local launch journal has a truncated tail");
    const events = raw.split("\n").filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line) as WheelLocalMachineLaunchEvent;
      } catch {
        throw new Error(`local launch journal line ${index + 1} is invalid JSON`);
      }
    });
    let previousHash = ZERO_HASH;
    let previousClaim: WheelLocalMachineLaunchClaim | undefined;
    const mutations = new Set<string>();
    events.forEach((event, index) => {
      if (event.schema !== "wheel.zob.local-machine-launch-event.v1") throw new Error(`local launch event ${index + 1} schema is invalid`);
      if (event.launchId !== this.launchId || event.machineId !== this.machineId) throw new Error(`local launch event ${index + 1} identity mismatch`);
      if (event.sequence !== index + 1 || event.previousHash !== previousHash) throw new Error(`local launch event ${index + 1} lineage mismatch`);
      if (event.bodyStored !== false) throw new Error(`local launch event ${index + 1} is not body-free`);
      assertBodySafe(event, `journal[${index + 1}]`);
      if (sha256Canonical(eventPayload(event)) !== event.eventHash) throw new Error(`local launch event ${index + 1} hash mismatch`);
      assertSafeSupervisorId(event.mutationId, "mutationId");
      if (!Number.isFinite(Date.parse(event.occurredAt))) throw new Error(`local launch event ${index + 1} occurredAt is invalid`);
      if (mutations.has(event.mutationId)) throw new Error(`duplicate mutationId ${event.mutationId}`);
      mutations.add(event.mutationId);
      assertWheelLocalMachineLaunchClaim(event.claim);
      if (event.claim.launchId !== this.launchId || event.claim.machineId !== this.machineId) throw new Error(`local launch event ${index + 1} claim identity mismatch`);
      if (event.claim.status !== statusForKind(event.kind)) throw new Error(`local launch event ${index + 1} kind/status mismatch`);
      if (!previousClaim) {
        if (event.kind !== "machine-claimed" || event.claim.ownershipEpoch !== 1) throw new Error("local launch journal must begin with epoch-1 machine-claimed");
      } else {
        const immutableBindings: Array<[string, unknown, unknown]> = [
          ["claimId", event.claim.claimId, previousClaim.claimId],
          ["planHash", event.claim.planHash, previousClaim.planHash],
          ["assignmentHash", event.claim.assignmentHash, previousClaim.assignmentHash],
          ["workspaceRootHash", event.claim.workspaceRootHash, previousClaim.workspaceRootHash],
          ["workspaceHeadSha", event.claim.workspaceHeadSha, previousClaim.workspaceHeadSha],
          ["workspaceBranch", event.claim.workspaceBranch, previousClaim.workspaceBranch],
          ["claimedAt", event.claim.claimedAt, previousClaim.claimedAt],
          ["confirmationHash", event.claim.confirmationHash, previousClaim.confirmationHash],
        ];
        for (const [label, actual, expected] of immutableBindings) if (actual !== expected) throw new Error(`local launch event ${index + 1} changed immutable ${label}`);
        if (event.kind === "machine-recovered") {
          if (event.claim.ownershipEpoch !== previousClaim.ownershipEpoch + 1) throw new Error("machine recovery must increment ownership epoch exactly once");
        } else {
          if (event.claim.ownershipEpoch !== previousClaim.ownershipEpoch) throw new Error("non-recovery event changed ownership epoch");
          if (event.claim.ownerIdHash !== previousClaim.ownerIdHash || event.claim.sessionIdHash !== previousClaim.sessionIdHash) throw new Error("non-recovery event changed owner or session");
          if (event.claim.zagentPresenceReceiptHash !== previousClaim.zagentPresenceReceiptHash) throw new Error("non-recovery event changed ZAgent presence receipt");
          if (!transitionAllowed(previousClaim.status, event.claim.status)) throw new Error(`invalid local launch transition ${previousClaim.status}->${event.claim.status}`);
        }
      }
      previousHash = event.eventHash;
      previousClaim = event.claim;
    });
    return events;
  }

  loadClaim(): WheelLocalMachineLaunchClaim | undefined {
    return structuredClone(this.loadEvents().at(-1)?.claim);
  }

  status(now = new Date().toISOString()): WheelLocalMachineLaunchStatusReport {
    try {
      const events = this.loadEvents();
      const claim = events.at(-1)?.claim;
      const head = events.at(-1)?.eventHash ?? ZERO_HASH;
      let checkpointCurrent = events.length === 0 && !existsSync(this.checkpointPath);
      if (events.length > 0 && existsSync(this.checkpointPath)) {
        const checkpoint = readJson<WheelLocalMachineCheckpoint>(this.checkpointPath);
        assertBodySafe(checkpoint, "checkpoint");
        checkpointCurrent = checkpoint.schema === "wheel.zob.local-machine-launch-checkpoint.v1"
          && checkpoint.launchId === this.launchId
          && checkpoint.machineId === this.machineId
          && checkpoint.eventCount === events.length
          && checkpoint.journalHeadHash === head
          && checkpoint.claimHash === sha256Canonical(claim)
          && sha256Canonical(checkpoint.claim) === checkpoint.claimHash;
      }
      let ownershipLive = false;
      if (existsSync(this.ownershipLockPath)) {
        const lock = readJson<WheelLocalMachineOwnershipLock>(this.ownershipLockPath);
        validateOwnershipLock(lock);
        ownershipLive = claim !== undefined
          && lock.launchId === this.launchId
          && lock.machineId === this.machineId
          && lock.planHash === claim.planHash
          && lock.assignmentHash === claim.assignmentHash
          && lock.ownerIdHash === claim.ownerIdHash
          && lock.sessionIdHash === claim.sessionIdHash
          && lock.workspaceRootHash === claim.workspaceRootHash
          && lock.ownershipEpoch === claim.ownershipEpoch
          && Date.parse(lock.expiresAt) > Date.parse(now);
      }
      const recoveryReasons: string[] = [];
      if (!checkpointCurrent) recoveryReasons.push("checkpoint-stale-or-missing");
      if (claim && !ownershipLive) recoveryReasons.push("ownership-missing-expired-or-mismatched");
      return {
        schema: "wheel.zob.local-machine-launch-status.v1",
        launchId: this.launchId,
        machineId: this.machineId,
        valid: true,
        issueCodes: [],
        claim: claim ? structuredClone(claim) : undefined,
        eventCount: events.length,
        journalHeadHash: head,
        checkpointCurrent,
        recoveryRequired: recoveryReasons.length > 0,
        recoveryReasons,
        ownershipLive,
        recoveredExpiredOwnerCount: events.filter((event) => event.kind === "machine-recovered").length,
        processSpawned: false,
        commitEnabled: false,
        githubEffectsEnabled: false,
        bodyStored: false,
      };
    } catch (error) {
      return {
        schema: "wheel.zob.local-machine-launch-status.v1",
        launchId: this.launchId,
        machineId: this.machineId,
        valid: false,
        issueCodes: [error instanceof Error ? error.message : String(error)],
        eventCount: 0,
        journalHeadHash: ZERO_HASH,
        checkpointCurrent: false,
        recoveryRequired: true,
        recoveryReasons: ["integrity-validation-failed"],
        ownershipLive: false,
        recoveredExpiredOwnerCount: 0,
        processSpawned: false,
        commitEnabled: false,
        githubEffectsEnabled: false,
        bodyStored: false,
      };
    }
  }

  claim(input: {
    planHash: string;
    machineId: string;
    confirmationPhrase: string;
    ownerId: string;
    sessionId: string;
    workspace: WheelLocalWorkspaceInspection;
    zagentPresenceReceiptHash?: string;
    now?: string;
    leaseMs?: number;
  }): { claim: WheelLocalMachineLaunchClaim; replayed: boolean } {
    const plan = loadWheelLocalMachineLaunchPlan(this.repoRoot, this.launchId, { now: input.now });
    if (input.planHash !== plan.planHash) throw new Error("local launch plan hash confirmation is stale or incorrect");
    if (input.machineId !== this.machineId) throw new Error("machineId does not match local launch store");
    const assignment = plan.assignments.find((item) => item.machineId === this.machineId);
    if (!assignment) throw new Error(`machine ${this.machineId} is not selected in local launch ${this.launchId}`);
    if (input.confirmationPhrase !== wheelLocalMachineStartConfirmation(plan, this.machineId)) throw new Error("local machine start confirmation does not bind the exact launch plan and machine");
    if (!input.workspace.linkedWorktree) throw new Error("local machine claim requires an isolated linked worktree");
    if (!GIT_OBJECT_ID.test(input.workspace.headSha)) throw new Error("workspace head sha is invalid");
    if (input.ownerId.trim().length === 0 || input.sessionId.trim().length === 0) throw new Error("ownerId and sessionId must be non-empty");
    if (input.zagentPresenceReceiptHash !== undefined && !SHA64.test(input.zagentPresenceReceiptHash)) throw new Error("zagentPresenceReceiptHash must be a full lowercase sha256");
    const now = input.now ?? new Date().toISOString();
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new Error("claim time is invalid");
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS) throw new Error(`leaseMs must be an integer between 1 and ${MAX_LEASE_MS}`);
    const ownerIdHash = sha256Text(input.ownerId);
    const sessionIdHash = sha256Text(input.sessionId);
    const existingEvents = this.loadEvents();
    this.assertCheckpointCurrent(existingEvents);
    const existingClaim = existingEvents.at(-1)?.claim;
    if (existingClaim) {
      if (existsSync(this.ownershipLockPath)) {
        const lock = readJson<WheelLocalMachineOwnershipLock>(this.ownershipLockPath);
        validateOwnershipLock(lock);
        if (
          Date.parse(lock.expiresAt) > nowMs
          && lock.ownerIdHash === ownerIdHash
          && lock.sessionIdHash === sessionIdHash
          && lock.workspaceRootHash === input.workspace.workspaceRootHash
          && existingClaim.planHash === plan.planHash
          && existingClaim.workspaceHeadSha === input.workspace.headSha
          && existingClaim.workspaceBranch === input.workspace.branchName
          && existingClaim.zagentPresenceReceiptHash === input.zagentPresenceReceiptHash
        ) return { claim: structuredClone(existingClaim), replayed: true };
      }
      throw new Error("local machine already has durable state; use status or exact recovery instead of a new initial claim");
    }
    if (!input.workspace.clean) throw new Error("initial local machine claim requires a clean worktree");
    ensureDirectory(this.machineDirectory);
    const lock: WheelLocalMachineOwnershipLock = {
      schema: "wheel.zob.local-machine-ownership-lock.v1",
      launchId: this.launchId,
      planHash: plan.planHash,
      machineId: this.machineId,
      assignmentHash: assignment.assignmentHash,
      ownerIdHash,
      sessionIdHash,
      workspaceRootHash: input.workspace.workspaceRootHash,
      ownershipEpoch: 1,
      acquiredAt: now,
      expiresAt: new Date(nowMs + leaseMs).toISOString(),
      bodyStored: false,
    };
    if (existsSync(this.ownershipLockPath)) {
      const existing = readJson<WheelLocalMachineOwnershipLock>(this.ownershipLockPath);
      validateOwnershipLock(existing);
      if (Date.parse(existing.expiresAt) > nowMs && (existing.ownerIdHash !== ownerIdHash || existing.sessionIdHash !== sessionIdHash)) {
        throw new Error("local machine ownership is held by another live session");
      }
      if (existing.ownerIdHash !== ownerIdHash || existing.sessionIdHash !== sessionIdHash || existing.workspaceRootHash !== input.workspace.workspaceRootHash) {
        throw new Error("orphaned ownership lock does not match this session; wait for expiry and recover exactly");
      }
    } else {
      const descriptor = openSync(this.ownershipLockPath, "wx", 0o600);
      try {
        writeSync(descriptor, `${JSON.stringify(lock, null, 2)}\n`, undefined, "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      fsyncDirectory(this.machineDirectory);
    }
    const claimId = `claim-${sha256Canonical({ launchId: this.launchId, machineId: this.machineId, planHash: plan.planHash, ownerIdHash, sessionIdHash, workspaceRootHash: input.workspace.workspaceRootHash }).slice(0, 24)}`;
    const claim: WheelLocalMachineLaunchClaim = {
      schema: "wheel.zob.local-machine-launch-claim.v1",
      claimId,
      launchId: this.launchId,
      planHash: plan.planHash,
      machineId: this.machineId,
      assignmentHash: assignment.assignmentHash,
      ownerIdHash,
      sessionIdHash,
      workspaceRootHash: input.workspace.workspaceRootHash,
      workspaceHeadSha: input.workspace.headSha,
      workspaceBranch: input.workspace.branchName,
      linkedWorktree: true,
      cleanAtInitialClaim: true,
      ownershipEpoch: 1,
      claimedAt: now,
      updatedAt: now,
      leaseExpiresAt: lock.expiresAt,
      status: "claimed",
      confirmationHash: sha256Text(input.confirmationPhrase),
      zagentPresenceReceiptHash: input.zagentPresenceReceiptHash,
      evidenceRefs: [],
      evidenceHashes: [],
      commitEnabled: false,
      pushEnabled: false,
      githubEffectsEnabled: false,
      bodyStored: false,
    };
    assertWheelLocalMachineLaunchClaim(claim);
    const event: WheelLocalMachineLaunchEvent = {
      schema: "wheel.zob.local-machine-launch-event.v1",
      launchId: this.launchId,
      machineId: this.machineId,
      sequence: 0,
      previousHash: ZERO_HASH,
      eventHash: ZERO_HASH,
      mutationId: `claim-${claimId}`,
      kind: "machine-claimed",
      claim,
      occurredAt: now,
      bodyStored: false,
    };
    return this.append(event);
  }

  transition(input: {
    ownerId: string;
    sessionId: string;
    ownershipEpoch: number;
    mutationId: string;
    status: Exclude<WheelLocalMachineLaunchStatus, "claimed">;
    occurredAt?: string;
    evidenceRefs?: string[];
    evidenceHashes?: string[];
    blockerHash?: string;
    crashAfterJournalAppend?: boolean;
  }): { claim: WheelLocalMachineLaunchClaim; replayed: boolean } {
    assertSafeSupervisorId(input.mutationId, "mutationId");
    const transitionEvents = this.loadEvents();
    this.assertCheckpointCurrent(transitionEvents);
    const replay = transitionEvents.find((event) => event.mutationId === input.mutationId);
    if (replay) {
      if (replay.sequence !== transitionEvents.length) throw new Error(`mutationId ${input.mutationId} is a stale historical replay`);
      const expectedKind = eventKindForStatus(input.status);
      const expectedEvidenceRefs = input.evidenceRefs ?? replay.claim.evidenceRefs;
      const expectedEvidenceHashes = input.evidenceHashes ?? replay.claim.evidenceHashes;
      if (
        replay.kind !== expectedKind
        || replay.claim.ownerIdHash !== sha256Text(input.ownerId)
        || replay.claim.sessionIdHash !== sha256Text(input.sessionId)
        || replay.claim.ownershipEpoch !== input.ownershipEpoch
        || sha256Canonical(replay.claim.evidenceRefs) !== sha256Canonical(expectedEvidenceRefs)
        || sha256Canonical(replay.claim.evidenceHashes) !== sha256Canonical(expectedEvidenceHashes)
        || replay.claim.blockerHash !== (input.status === "blocked" ? input.blockerHash : undefined)
      ) throw new Error(`mutationId ${input.mutationId} payload conflict`);
      if (!existsSync(this.ownershipLockPath)) throw new Error("local machine ownership lock is missing");
      const replayLock = readJson<WheelLocalMachineOwnershipLock>(this.ownershipLockPath);
      validateOwnershipLock(replayLock);
      const replayAt = Date.parse(input.occurredAt ?? new Date().toISOString());
      if (
        Date.parse(replayLock.expiresAt) <= replayAt
        || replayLock.ownerIdHash !== replay.claim.ownerIdHash
        || replayLock.sessionIdHash !== replay.claim.sessionIdHash
        || replayLock.ownershipEpoch !== replay.claim.ownershipEpoch
      ) throw new Error(`mutationId ${input.mutationId} replay is fenced by current ownership`);
      return { claim: structuredClone(replay.claim), replayed: true };
    }
    const current = this.loadClaim();
    if (!current) throw new Error("local machine has not been claimed");
    if (!transitionAllowed(current.status, input.status)) throw new Error(`invalid local machine transition ${current.status}->${input.status}`);
    if (!existsSync(this.ownershipLockPath)) throw new Error("local machine ownership lock is missing");
    const lock = readJson<WheelLocalMachineOwnershipLock>(this.ownershipLockPath);
    validateOwnershipLock(lock);
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    if (Date.parse(lock.expiresAt) <= Date.parse(occurredAt)) throw new Error("local machine ownership lease expired; exact recovery is required");
    const ownerIdHash = sha256Text(input.ownerId);
    const sessionIdHash = sha256Text(input.sessionId);
    if (
      lock.ownerIdHash !== ownerIdHash
      || lock.sessionIdHash !== sessionIdHash
      || lock.ownershipEpoch !== input.ownershipEpoch
      || current.ownerIdHash !== ownerIdHash
      || current.sessionIdHash !== sessionIdHash
      || current.ownershipEpoch !== input.ownershipEpoch
    ) throw new Error("local machine transition is fenced by the current owner, session, or epoch");
    const evidenceRefs = input.evidenceRefs ?? current.evidenceRefs;
    const evidenceHashes = input.evidenceHashes ?? current.evidenceHashes;
    if (evidenceRefs.length !== evidenceHashes.length || !evidenceHashes.every((hash) => SHA64.test(hash))) throw new Error("evidence refs and hashes must align one-for-one");
    if (input.status === "local-ready" && evidenceRefs.length === 0) throw new Error("local-ready transition requires validation evidence refs and hashes");
    if (input.status === "blocked" && !input.blockerHash) throw new Error("blocked transition requires blockerHash");
    const claim: WheelLocalMachineLaunchClaim = {
      ...current,
      updatedAt: occurredAt,
      status: input.status,
      evidenceRefs: [...evidenceRefs],
      evidenceHashes: [...evidenceHashes],
      blockerHash: input.status === "blocked" ? input.blockerHash : undefined,
    };
    assertWheelLocalMachineLaunchClaim(claim);
    const event: WheelLocalMachineLaunchEvent = {
      schema: "wheel.zob.local-machine-launch-event.v1",
      launchId: this.launchId,
      machineId: this.machineId,
      sequence: 0,
      previousHash: ZERO_HASH,
      eventHash: ZERO_HASH,
      mutationId: input.mutationId,
      kind: eventKindForStatus(input.status),
      claim,
      occurredAt,
      bodyStored: false,
    };
    return this.append(event, { crashAfterJournalAppend: input.crashAfterJournalAppend });
  }

  recover(input: {
    ownerId: string;
    sessionId: string;
    confirmationPhrase: string;
    workspace: WheelLocalWorkspaceInspection;
    zagentPresenceReceiptHash?: string;
    now?: string;
    leaseMs?: number;
  }): { claim: WheelLocalMachineLaunchClaim; replayed: boolean; recoveredExpiredOwner: true } {
    const events = this.loadEvents();
    this.assertCheckpointCurrent(events);
    const replay = [...events].reverse().find((event) => event.kind === "machine-recovered"
      && input.confirmationPhrase === wheelLocalMachineRecoveryConfirmation({
        launchId: this.launchId,
        machineId: this.machineId,
        planHash: event.claim.planHash,
        ownershipEpoch: event.claim.ownershipEpoch,
      }));
    if (replay) {
      const currentReplayClaim = events.at(-1)?.claim;
      if (!currentReplayClaim || currentReplayClaim.ownershipEpoch !== replay.claim.ownershipEpoch) {
        throw new Error(`recovery epoch ${replay.claim.ownershipEpoch} is stale relative to current epoch ${currentReplayClaim?.ownershipEpoch ?? 0}`);
      }
      if (
        currentReplayClaim.ownerIdHash !== sha256Text(input.ownerId)
        || currentReplayClaim.sessionIdHash !== sha256Text(input.sessionId)
        || currentReplayClaim.workspaceRootHash !== input.workspace.workspaceRootHash
        || currentReplayClaim.zagentPresenceReceiptHash !== input.zagentPresenceReceiptHash
      ) throw new Error(`recovery epoch ${replay.claim.ownershipEpoch} replay conflicts with its current owner, session, or workspace`);
      if (!existsSync(this.ownershipLockPath)) throw new Error("recovery replay is missing its current ownership lock");
      const replayLock = readJson<WheelLocalMachineOwnershipLock>(this.ownershipLockPath);
      validateOwnershipLock(replayLock);
      const replayNow = Date.parse(input.now ?? new Date().toISOString());
      if (
        Date.parse(replayLock.expiresAt) <= replayNow
        || replayLock.ownerIdHash !== currentReplayClaim.ownerIdHash
        || replayLock.sessionIdHash !== currentReplayClaim.sessionIdHash
        || replayLock.ownershipEpoch !== currentReplayClaim.ownershipEpoch
      ) throw new Error(`recovery epoch ${replay.claim.ownershipEpoch} replay is fenced by current ownership`);
      return { claim: structuredClone(currentReplayClaim), replayed: true, recoveredExpiredOwner: true };
    }
    const current = events.at(-1)?.claim;
    if (!current) throw new Error("local machine has no durable claim to recover");
    const plan = loadWheelLocalMachineLaunchPlan(this.repoRoot, this.launchId, { now: input.now });
    if (plan.planHash !== current.planHash) throw new Error("recovery plan hash does not match durable claim");
    const nextEpoch = current.ownershipEpoch + 1;
    const expectedPhrase = wheelLocalMachineRecoveryConfirmation({
      launchId: this.launchId,
      machineId: this.machineId,
      planHash: plan.planHash,
      ownershipEpoch: nextEpoch,
    });
    if (input.confirmationPhrase !== expectedPhrase) throw new Error("recovery confirmation does not bind the exact launch, machine, plan, and next epoch");
    if (!input.workspace.linkedWorktree) throw new Error("recovery requires the original isolated linked worktree");
    if (input.workspace.workspaceRootHash !== current.workspaceRootHash) throw new Error("recovery workspace does not match original claim");
    if (input.workspace.headSha !== current.workspaceHeadSha) throw new Error("recovery blocked because workspace HEAD changed before commit authority");
    if (input.workspace.branchName !== current.workspaceBranch) throw new Error("recovery workspace branch does not match original claim");
    if (input.zagentPresenceReceiptHash !== undefined && !SHA64.test(input.zagentPresenceReceiptHash)) throw new Error("zagentPresenceReceiptHash must be a full lowercase sha256");
    const now = input.now ?? new Date().toISOString();
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new Error("recovery time is invalid");
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS) throw new Error(`leaseMs must be an integer between 1 and ${MAX_LEASE_MS}`);
    if (existsSync(this.ownershipLockPath)) {
      const existing = readJson<WheelLocalMachineOwnershipLock>(this.ownershipLockPath);
      validateOwnershipLock(existing);
      if (Date.parse(existing.expiresAt) > nowMs) throw new Error("local machine ownership is still live; recovery is not permitted");
      const stalePath = `${this.ownershipLockPath}.stale.${sha256Canonical(existing).slice(0, 16)}.json`;
      renameSync(this.ownershipLockPath, stalePath);
    }
    const ownerIdHash = sha256Text(input.ownerId);
    const sessionIdHash = sha256Text(input.sessionId);
    const expiresAt = new Date(nowMs + leaseMs).toISOString();
    const lock: WheelLocalMachineOwnershipLock = {
      schema: "wheel.zob.local-machine-ownership-lock.v1",
      launchId: this.launchId,
      planHash: plan.planHash,
      machineId: this.machineId,
      assignmentHash: current.assignmentHash,
      ownerIdHash,
      sessionIdHash,
      workspaceRootHash: current.workspaceRootHash,
      ownershipEpoch: nextEpoch,
      acquiredAt: now,
      expiresAt,
      bodyStored: false,
    };
    ensureDirectory(this.machineDirectory);
    const descriptor = openSync(this.ownershipLockPath, "wx", 0o600);
    try {
      writeSync(descriptor, `${JSON.stringify(lock, null, 2)}\n`, undefined, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    fsyncDirectory(this.machineDirectory);
    const claim: WheelLocalMachineLaunchClaim = {
      ...current,
      ownerIdHash,
      sessionIdHash,
      ownershipEpoch: nextEpoch,
      updatedAt: now,
      leaseExpiresAt: expiresAt,
      status: "started",
      zagentPresenceReceiptHash: input.zagentPresenceReceiptHash,
      blockerHash: undefined,
    };
    assertWheelLocalMachineLaunchClaim(claim);
    const event: WheelLocalMachineLaunchEvent = {
      schema: "wheel.zob.local-machine-launch-event.v1",
      launchId: this.launchId,
      machineId: this.machineId,
      sequence: 0,
      previousHash: ZERO_HASH,
      eventHash: ZERO_HASH,
      mutationId: `recover-${nextEpoch}-${sha256Text(input.confirmationPhrase).slice(0, 16)}`,
      kind: "machine-recovered",
      claim,
      occurredAt: now,
      bodyStored: false,
    };
    const result = this.append(event);
    return { ...result, recoveredExpiredOwner: true };
  }

  repairCheckpoint(writtenAt = new Date().toISOString()): WheelLocalMachineLaunchStatusReport {
    const events = this.loadEvents();
    const latest = events.at(-1);
    if (!latest) throw new Error("local machine has no journal to checkpoint");
    this.writeCheckpoint(latest.claim, events.length, latest.eventHash, writtenAt);
    return this.status(writtenAt);
  }

  planRef(): string {
    return relative(this.repoRoot, resolve(resolveWheelLocalLaunchDirectory(this.repoRoot, this.launchId), "launch-plan.json")).split("\\").join("/");
  }
}
