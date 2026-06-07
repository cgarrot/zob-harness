import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { sha256 } from "../core/utils/hashing.js";

type LogicalFrame = readonly string[];
type ZobIntroStyleName = "accent" | "plain";

type ZobIntroOptions = {
  blockWidth: number;
  blockHeight: number;
  tickMs: number;
  repeat: number | null;
  style: ZobIntroStyleName;
};

type ZobIntroParseResult =
  | { ok: true; help: false; options: ZobIntroOptions }
  | { ok: true; help: true; options: ZobIntroOptions }
  | { ok: false; errors: string[]; options: ZobIntroOptions };

type ZobIntroStyles = {
  accent: (text: string) => string;
  block: (text: string) => string;
  bold: (text: string) => string;
  dim: (text: string) => string;
  exhaustHot: (text: string) => string;
  exhaustDim: (text: string) => string;
  warning: (text: string) => string;
};

const WELCOME_TITLE = "Welcome to the ZOB Harness";
const START_PROMPT = "Press Enter/Space to continue";
const FIRST_RUN_MARKER_FILE_NAME = "zob-intro-first-run.json";
const LEGACY_FIRST_RUN_MARKER_RELATIVE_PATH = ".pi/tmp/zob-intro-first-run.json";
const FIRST_RUN_ARGS = "once fast";

const DEFAULT_ZOB_INTRO_OPTIONS: ZobIntroOptions = {
  blockWidth: 6,
  blockHeight: 3,
  tickMs: 180,
  repeat: 3,
  style: "accent",
};

const ZOB_INTRO_MIN_CANVAS_COLS = 8;
const ZOB_INTRO_EXIT_FRAME_COUNT = 10;
const ZOB_INTRO_WRAP_PAUSE_FRAME_COUNT = 2;
const ZOB_INTRO_WRAP_PASS_FRAME_COUNT = 8;
const BUILD_FRAME_TICK_HOLD = 2;
const WELCOME_TEXT_SHIFT_LEFT = -3;

const ZOB_INTRO_TARGET_FRAME = [
  "###.....",
  "#.#####.",
  "###....#",
  "#.#####.",
  "###.....",
] as const satisfies LogicalFrame;

const ZOB_INTRO_MORPH_FRAMES = [
  ["###.", "#.#.", "##.#", "#..#"],
  ["###.", "#.#.", "##+#", "#.+#"],
  ["###.", "#.#.", "###.", "#.#."],
  ["###.", "#.#.", "###.", "#.#.", "+..."],
  ["###.", "#.#.", "###.", "#.#.", "#..."],
  ["###.", "#.#.", "###.", "#.#.", "#+.."],
  ["###.", "#.#.", "###.", "#.#.", "##.."],
  ["###.....", "#.#.....", "###.....", "#.#.....", "##+....."],
  ["###.....", "#.#.....", "###.....", "#.#.....", "###....."],
  ["###.....", "#.#+....", "###.+...", "#.#+....", "###....."],
  ["###.....", "#.##....", "###.#...", "#.##....", "###....."],
  ["###.....", "#.##+...", "###..+..", "#.##+...", "###....."],
  ["###.....", "#.###...", "###..#..", "#.###...", "###....."],
  ["###.....", "#.###+..", "###...+.", "#.###+..", "###....."],
  ["###.....", "#.####..", "###...#.", "#.####..", "###....."],
  ["###.....", "#.####+.", "###....+", "#.####+.", "###....."],
  ZOB_INTRO_TARGET_FRAME,
] as const satisfies readonly LogicalFrame[];

function frameWidth(frame: LogicalFrame): number {
  return Math.max(...frame.map((row) => row.length));
}

function centerOffset(frame: LogicalFrame, width: number): number {
  return Math.max(0, Math.floor((width - frameWidth(frame)) / 2));
}

function placeFrame(frame: LogicalFrame, offsetX: number, width: number): string[] {
  return frame.map((row) => {
    const cells = Array.from({ length: width }, () => ".");
    for (let sourceX = 0; sourceX < row.length; sourceX += 1) {
      const cell = row[sourceX];
      if (!cell || cell === ".") continue;
      const targetX = offsetX + sourceX;
      if (targetX >= 0 && targetX < width) cells[targetX] = cell;
    }
    return cells.join("");
  });
}

function writeCells(row: string[], startX: number, pattern: string): void {
  for (let index = 0; index < pattern.length; index += 1) {
    const targetX = startX + index;
    if (targetX < 0 || targetX >= row.length) continue;
    if (row[targetX] !== ".") continue;
    row[targetX] = pattern[index] ?? ".";
  }
}

function buildLaserPattern(length: number, pulse: number, lane: number): string {
  return Array.from({ length }, (_unused, index) => {
    const phase = (index + pulse + lane * 2) % 7;
    if (phase <= 1) return "=";
    if (phase === 2 || phase === 5) return "-";
    if (phase === 3) return "~";
    return ".";
  }).join("");
}

function withLaserRays(frame: LogicalFrame, rayStartX: number, pulse: number, width: number, boosted = false): string[] {
  const rows = frame.map((row) => row.padEnd(width, ".").slice(0, width).split(""));
  const start = Math.max(0, rayStartX);
  const length = Math.max(0, width - start);
  if (boosted && rows[1]) writeCells(rows[1], start, buildLaserPattern(Math.max(0, length - 2), pulse, 1));
  if (rows[2]) writeCells(rows[2], start, buildLaserPattern(length, pulse + 1, 0));
  if (boosted && rows[3]) writeCells(rows[3], start, buildLaserPattern(Math.max(0, length - 1), pulse + 2, 2));
  return rows.map((row) => row.join(""));
}

function emptyIntroFrame(width: number): LogicalFrame {
  return Array.from({ length: LOGICAL_ROWS }, () => ".".repeat(width));
}

function buildExitFrame(exitIndex: number, width: number, startOffset: number, endOffset: number, pulseOffset = 0, boosted = false): LogicalFrame {
  const targetWidth = frameWidth(ZOB_INTRO_TARGET_FRAME);
  const denominator = Math.max(1, ZOB_INTRO_EXIT_FRAME_COUNT - 1);
  const rawT = Math.min(1, exitIndex / denominator);
  const t = rawT * rawT;
  const offsetX = Math.round(startOffset + (endOffset - startOffset) * t);
  const shiftedWholeLogo = placeFrame(ZOB_INTRO_TARGET_FRAME, offsetX, width);
  return withLaserRays(shiftedWholeLogo, offsetX + targetWidth, exitIndex + pulseOffset, width, boosted);
}

function buildWrapPassFrame(passIndex: number, width: number): LogicalFrame {
  const targetWidth = frameWidth(ZOB_INTRO_TARGET_FRAME);
  const startOffset = width + 1;
  const endOffset = -targetWidth - 1;
  const denominator = Math.max(1, ZOB_INTRO_WRAP_PASS_FRAME_COUNT - 1);
  const t = Math.min(1, passIndex / denominator);
  const offsetX = Math.round(startOffset + (endOffset - startOffset) * t);
  const shiftedWholeLogo = placeFrame(ZOB_INTRO_TARGET_FRAME, offsetX, width);
  return withLaserRays(shiftedWholeLogo, offsetX + targetWidth, passIndex + ZOB_INTRO_EXIT_FRAME_COUNT, width, true);
}

function buildIntroFrame(frameIndex: number, width: number): LogicalFrame {
  if (frameIndex < ZOB_INTRO_MORPH_FRAMES.length) {
    const frame = ZOB_INTRO_MORPH_FRAMES[frameIndex] ?? ZOB_INTRO_MORPH_FRAMES[0];
    return placeFrame(frame, centerOffset(frame, width), width);
  }

  let phaseIndex = Math.max(0, frameIndex - ZOB_INTRO_MORPH_FRAMES.length);
  const targetWidth = frameWidth(ZOB_INTRO_TARGET_FRAME);
  if (phaseIndex < ZOB_INTRO_EXIT_FRAME_COUNT) {
    return buildExitFrame(phaseIndex, width, centerOffset(ZOB_INTRO_TARGET_FRAME, width), -targetWidth - 1);
  }
  phaseIndex -= ZOB_INTRO_EXIT_FRAME_COUNT;
  if (phaseIndex < ZOB_INTRO_WRAP_PAUSE_FRAME_COUNT) return emptyIntroFrame(width);
  phaseIndex -= ZOB_INTRO_WRAP_PAUSE_FRAME_COUNT;
  return buildWrapPassFrame(phaseIndex, width);
}

const ZOB_INTRO_FRAME_COUNT = ZOB_INTRO_MORPH_FRAMES.length + ZOB_INTRO_EXIT_FRAME_COUNT + ZOB_INTRO_WRAP_PAUSE_FRAME_COUNT + ZOB_INTRO_WRAP_PASS_FRAME_COUNT;
const LOGICAL_ROWS = Math.max(...ZOB_INTRO_MORPH_FRAMES.map((frame) => frame.length));

function cloneDefaultOptions(): ZobIntroOptions {
  return { ...DEFAULT_ZOB_INTRO_OPTIONS };
}

function parsePositiveInt(value: string, label: string, min: number, max: number, errors: string[]): number | undefined {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    errors.push(`${label} must be an integer between ${min} and ${max}`);
    return undefined;
  }
  return parsed;
}

function parseZobIntroArgs(args: string): ZobIntroParseResult {
  const options = cloneDefaultOptions();
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const errors: string[] = [];
  let help = false;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]?.toLowerCase() ?? "";
    if (part === "help" || part === "--help" || part === "-h") {
      help = true;
      continue;
    }
    if (part === "loop") {
      options.repeat = null;
      continue;
    }
    if (part === "once") {
      options.repeat = 1;
      continue;
    }
    if (part === "fast") {
      options.tickMs = 90;
      continue;
    }
    if (part === "slow") {
      options.tickMs = 300;
      continue;
    }
    if (part === "normal") {
      options.tickMs = DEFAULT_ZOB_INTRO_OPTIONS.tickMs;
      continue;
    }
    if (part === "plain" || part === "mono") {
      options.style = "plain";
      continue;
    }
    if (part === "accent" || part === "neon") {
      options.style = "accent";
      continue;
    }
    if (part === "--repeat") {
      const next = parts[index + 1];
      if (!next) {
        errors.push("--repeat requires a positive integer or 'loop'");
        continue;
      }
      index += 1;
      if (next.toLowerCase() === "loop") options.repeat = null;
      else {
        const repeat = parsePositiveInt(next, "repeat", 1, 99, errors);
        if (repeat !== undefined) options.repeat = repeat;
      }
      continue;
    }
    if (part === "--speed" || part === "--tick-ms") {
      const next = parts[index + 1];
      if (!next) {
        errors.push(`${part} requires a millisecond value`);
        continue;
      }
      index += 1;
      const tickMs = parsePositiveInt(next, "tickMs", 30, 2_000, errors);
      if (tickMs !== undefined) options.tickMs = tickMs;
      continue;
    }
    const blockMatch = /^(\d+)x(\d+)$/.exec(part);
    if (blockMatch) {
      const blockWidth = parsePositiveInt(blockMatch[1] ?? "", "blockWidth", 1, 20, errors);
      const blockHeight = parsePositiveInt(blockMatch[2] ?? "", "blockHeight", 1, 12, errors);
      if (blockWidth !== undefined) options.blockWidth = blockWidth;
      if (blockHeight !== undefined) options.blockHeight = blockHeight;
      continue;
    }
    errors.push(`unknown option '${part}'`);
  }

  if (errors.length > 0) return { ok: false, errors, options };
  return { ok: true, help, options };
}

function zobIntroHelpTemplate(): string {
  return [
    "# ZOB intro animation",
    "",
    "Usage:",
    "/zob-intro                 # play the morph + whole-logo laser exit, default 6x3 terminal pixels",
    "/zob-intro once            # play once then close",
    "/zob-intro loop            # loop until ESC/Q",
    "/zob-intro fast 6x3 neon   # faster and wider terminal pixels",
    "/zob-intro slow 5x3 plain  # slower uncolored blocks",
    "/zob-intro reset-first-run # show the startup intro again on next Pi/ZOB launch",
    "",
    "Options:",
    "- once | loop | --repeat N",
    "- fast | normal | slow | --speed MS",
    "- 3x3 | 5x3 | 6x3 | any WxH up to 20x12",
    "- accent/neon | plain/mono",
    "",
    "Controls:",
    "- Enter or Space: start from welcome screen",
    "- ESC or Q: close",
    "- Space after start: pause/resume",
  ].join("\n");
}

function zobIntroArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const items: AutocompleteItem[] = [
    { value: "once", label: "once", description: "play one time then close" },
    { value: "loop", label: "loop", description: "loop until ESC/Q" },
    { value: "fast", label: "fast", description: "90ms per frame" },
    { value: "normal", label: "normal", description: "180ms per frame" },
    { value: "slow", label: "slow", description: "300ms per frame" },
    { value: "5x3", label: "5x3", description: "narrower terminal-pixel ratio" },
    { value: "6x3", label: "6x3", description: "default terminal-pixel ratio" },
    { value: "plain", label: "plain", description: "uncolored terminal foreground" },
    { value: "neon", label: "neon", description: "theme accent blocks" },
    { value: "reset-first-run", label: "reset-first-run", description: "show startup intro again on next Pi/ZOB launch" },
    { value: "help", label: "help", description: "insert usage help" },
  ];
  const filtered = query
    ? items.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))
    : items;
  return filtered.length > 0 ? filtered.slice(0, 20) : null;
}

function stableFrameHash(): string {
  return sha256(JSON.stringify({ morphFrames: ZOB_INTRO_MORPH_FRAMES, targetFrame: ZOB_INTRO_TARGET_FRAME, exitFrameCount: ZOB_INTRO_EXIT_FRAME_COUNT, wrapPauseFrameCount: ZOB_INTRO_WRAP_PAUSE_FRAME_COUNT, wrapPassFrameCount: ZOB_INTRO_WRAP_PASS_FRAME_COUNT }));
}

function appendZobIntroLedger(pi: ExtensionAPI, options: ZobIntroOptions, status: "played" | "blocked" | "help" | "reset" | "auto_skipped", errors: string[] = []): void {
  pi.appendEntry("zob-intro-command", {
    schema: "zob.intro-command.v1",
    status,
    frameCount: ZOB_INTRO_FRAME_COUNT,
    logicalCols: "dynamic",
    logicalRows: LOGICAL_ROWS,
    blockWidth: options.blockWidth,
    blockHeight: options.blockHeight,
    tickMs: options.tickMs,
    repeat: options.repeat ?? "loop",
    style: options.style,
    frameHash: stableFrameHash(),
    errorHashes: errors.map((error) => sha256(error)),
    rawFramesStored: false,
    bodyStored: false,
    generatedAt: new Date().toISOString(),
  });
}

function firstRunMarkerPath(): string {
  return join(homedir(), ".local", "state", "pi", "zob-harness", FIRST_RUN_MARKER_FILE_NAME);
}

function legacyFirstRunMarkerPath(cwd: string): string {
  return join(cwd, LEGACY_FIRST_RUN_MARKER_RELATIVE_PATH);
}

async function hasLegacyFirstRunIntroMarker(cwd: string): Promise<boolean> {
  try {
    await readFile(legacyFirstRunMarkerPath(cwd), "utf8");
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    return true;
  }
}

function firstRunMarkerBody(): string {
  return `${JSON.stringify({ schema: "zob.intro-first-run-marker.v1", seenAt: new Date().toISOString(), frameHash: stableFrameHash(), bodyStored: false }, null, 2)}\n`;
}

async function writeFirstRunIntroMarkerIfMissing(): Promise<boolean> {
  const markerPath = firstRunMarkerPath();
  await mkdir(dirname(markerPath), { recursive: true });
  try {
    const marker = await open(markerPath, "wx");
    try {
      await marker.writeFile(firstRunMarkerBody(), "utf8");
    } finally {
      await marker.close();
    }
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

async function shouldPlayFirstRunIntro(cwd: string): Promise<boolean> {
  if (await hasLegacyFirstRunIntroMarker(cwd)) {
    await writeFirstRunIntroMarkerIfMissing();
    return false;
  }
  return writeFirstRunIntroMarkerIfMissing();
}

async function resetFirstRunIntro(cwd: string): Promise<void> {
  const markerPaths = [firstRunMarkerPath(), legacyFirstRunMarkerPath(cwd)];
  for (const markerPath of markerPaths) {
    try {
      await unlink(markerPath);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}

class ZobIntroComponent implements Component {
  private frameIndex = 0;
  private completedCycles = 0;
  private paused = false;
  private interval: ReturnType<typeof setInterval> | undefined;
  private welcomeInterval: ReturnType<typeof setInterval> | undefined;
  private cachedWidth = 0;
  private cachedHeight = 0;
  private cachedVersion = -1;
  private cachedLines: string[] = [];
  private version = 0;
  private closed = false;
  private waitingForStart = true;
  private welcomeTick = 0;
  private buildHoldTick = 0;

  constructor(
    private readonly tui: Pick<TUI, "requestRender" | "terminal">,
    private readonly styles: ZobIntroStyles,
    private readonly options: ZobIntroOptions,
    private readonly onDone: () => void,
  ) {
    this.tui.terminal.clearScreen();
    this.tui.terminal.hideCursor();
    this.startWelcomeReveal();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.close();
      return;
    }
    if (this.waitingForStart) {
      if (matchesKey(data, "enter") || matchesKey(data, "space") || data === "\r" || data === "\n" || data === " ") {
        this.waitingForStart = false;
        this.stopWelcomeReveal();
        this.start();
        this.version += 1;
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, "space") || data === " ") {
      this.paused = !this.paused;
      this.version += 1;
      this.tui.requestRender();
    }
  }

  invalidate(): void {
    this.cachedWidth = 0;
    this.cachedHeight = 0;
    this.cachedVersion = -1;
  }

  render(width: number): string[] {
    const height = Math.max(1, this.tui.terminal.rows);
    if (this.cachedWidth === width && this.cachedHeight === height && this.cachedVersion === this.version) return this.cachedLines;

    const welcomeLines = this.waitingForStart ? this.renderWelcomeLines(width) : [];
    const artLines = this.renderArt(this.options.blockWidth, this.options.blockHeight, this.logicalColsForWidth(width));
    const emptyLine = " ".repeat(Math.max(0, width));
    const contentHeight = artLines.length + welcomeLines.length;
    const topPad = Math.max(0, Math.floor((height - contentHeight) / 2));
    const lines: string[] = [];

    for (let index = 0; index < topPad; index += 1) lines.push(emptyLine);
    for (const artLine of artLines) lines.push(this.centerLine(artLine, width));
    for (const welcomeLine of welcomeLines) lines.push(this.centerLine(welcomeLine, width, WELCOME_TEXT_SHIFT_LEFT));
    while (lines.length < height) lines.push(emptyLine);

    this.cachedLines = lines.slice(0, height);
    this.cachedWidth = width;
    this.cachedHeight = height;
    this.cachedVersion = this.version;
    return this.cachedLines;
  }

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.stopWelcomeReveal();
    this.tui.terminal.showCursor();
  }

  private startWelcomeReveal(): void {
    this.welcomeInterval = setInterval(() => {
      if (!this.waitingForStart) return;
      this.welcomeTick += 1;
      this.version += 1;
      this.tui.requestRender();
    }, 55);
    this.welcomeInterval.unref?.();
  }

  private stopWelcomeReveal(): void {
    if (!this.welcomeInterval) return;
    clearInterval(this.welcomeInterval);
    this.welcomeInterval = undefined;
  }

  private start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      if (this.paused) return;
      if (this.shouldHoldBuildFrame()) return;
      this.advanceFrame();
      this.version += 1;
      this.tui.requestRender();
    }, this.options.tickMs);
    this.interval.unref?.();
  }

  private shouldHoldBuildFrame(): boolean {
    if (this.frameIndex >= ZOB_INTRO_MORPH_FRAMES.length) {
      this.buildHoldTick = 0;
      return false;
    }
    this.buildHoldTick = (this.buildHoldTick + 1) % BUILD_FRAME_TICK_HOLD;
    return this.buildHoldTick !== 0;
  }

  private advanceFrame(): void {
    this.frameIndex += 1;
    if (this.frameIndex < ZOB_INTRO_FRAME_COUNT) return;

    this.completedCycles += 1;
    if (this.options.repeat !== null && this.completedCycles >= this.options.repeat) {
      this.frameIndex = ZOB_INTRO_FRAME_COUNT - 1;
      this.close();
      return;
    }
    this.frameIndex = 0;
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispose();
    this.onDone();
  }

  private renderWelcomeLines(width: number): string[] {
    const titleVisible = this.revealText(WELCOME_TITLE, this.welcomeTick);
    const promptStartTick = WELCOME_TITLE.length + 8;
    const promptVisible = this.revealText(START_PROMPT, Math.max(0, this.welcomeTick - promptStartTick));
    const title = this.styles.bold(this.styles.accent(titleVisible)) + " ".repeat(Math.max(0, WELCOME_TITLE.length - titleVisible.length));
    const promptPulse = Math.floor(this.welcomeTick / 12) % 2 === 0;
    const promptText = promptPulse ? this.styles.dim(promptVisible) : this.styles.accent(promptVisible);
    const prompt = promptText + " ".repeat(Math.max(0, START_PROMPT.length - promptVisible.length));
    return ["", title, prompt].filter((line) => visibleWidth(line) <= width || line.length > 0);
  }

  private revealText(text: string, tick: number): string {
    if (tick <= 0) return "";
    return text.slice(0, Math.min(text.length, tick));
  }

  private logicalColsForWidth(width: number): number {
    return Math.max(ZOB_INTRO_MIN_CANVAS_COLS, Math.floor(width / Math.max(1, this.options.blockWidth)));
  }

  private renderArt(blockWidth: number, blockHeight: number, logicalCols: number): string[] {
    const frame = buildIntroFrame(this.frameIndex, logicalCols);
    const lines: string[] = [];

    for (let rowIndex = 0; rowIndex < LOGICAL_ROWS; rowIndex += 1) {
      const logicalRow = (frame[rowIndex] ?? "").padEnd(logicalCols, ".").slice(0, logicalCols);
      for (let subRow = 0; subRow < blockHeight; subRow += 1) {
        let renderedRow = "";
        for (const cell of logicalRow) renderedRow += this.renderCell(cell, subRow, blockWidth, blockHeight);
        lines.push(renderedRow);
      }
    }
    return lines;
  }

  private renderCell(cell: string, subRow: number, blockWidth: number, blockHeight: number): string {
    const blank = " ".repeat(blockWidth);
    const solid = (glyph: string, color: (text: string) => string): string => {
      const text = glyph.repeat(blockWidth);
      return this.options.style === "plain" ? text : color(text);
    };
    if (cell === "#") return solid("█", this.styles.block);
    if (cell === "*") return solid("▓", this.styles.exhaustHot);
    if (cell === "+") return solid("▒", this.styles.exhaustDim);
    if (cell === "=") {
      const middle = Math.floor(blockHeight / 2);
      return subRow === middle ? solid("━", this.styles.exhaustHot) : blank;
    }
    if (cell === "~") {
      const middle = Math.floor(blockHeight / 2);
      return subRow === middle ? solid("·", this.styles.exhaustDim) : blank;
    }
    if (cell === "-") {
      const middle = Math.floor(blockHeight / 2);
      return subRow === middle ? solid("─", this.styles.exhaustDim) : blank;
    }
    return blank;
  }

  private centerLine(line: string, width: number, shiftRight = 0): string {
    if (width <= 0) return "";
    const lineWidth = visibleWidth(line);
    if (lineWidth >= width) return truncateToWidth(line, width, "");
    const leftPad = Math.max(0, Math.min(width - lineWidth, Math.floor((width - lineWidth) / 2) + shiftRight));
    return `${" ".repeat(leftPad)}${line}`;
  }
}

async function handleZobIntroCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
  const normalized = args.trim().toLowerCase();
  if (normalized === "reset-first-run" || normalized === "reset-startup" || normalized === "reset") {
    await resetFirstRunIntro(ctx.cwd);
    appendZobIntroLedger(pi, DEFAULT_ZOB_INTRO_OPTIONS, "reset");
    ctx.ui.notify("ZOB intro first-run marker reset. Quit and relaunch Pi/ZOB to see the startup intro again.", "info");
    return;
  }

  const parsed = parseZobIntroArgs(args);
  if (parsed.ok && parsed.help) {
    appendZobIntroLedger(pi, parsed.options, "help");
    ctx.ui.setEditorText(zobIntroHelpTemplate());
    ctx.ui.notify("ZOB intro help inserted. Use /zob-intro or /zob-intro loop.", "info");
    return;
  }
  if (!parsed.ok) {
    appendZobIntroLedger(pi, parsed.options, "blocked", parsed.errors);
    ctx.ui.notify(`/zob-intro blocked: ${parsed.errors.join(" | ")}. Use /zob-intro help.`, "warning");
    return;
  }
  if (!ctx.hasUI) {
    appendZobIntroLedger(pi, parsed.options, "blocked", ["interactive UI required"]);
    ctx.ui.notify("/zob-intro requires interactive Pi TUI mode.", "warning");
    return;
  }

  appendZobIntroLedger(pi, parsed.options, "played");
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const styles: ZobIntroStyles = {
      accent: (text) => theme.fg("accent", text),
      block: (text) => theme.fg("accent", text),
      bold: (text) => theme.bold(text),
      dim: (text) => theme.fg("dim", text),
      exhaustHot: (text) => theme.fg("warning", text),
      exhaustDim: (text) => theme.fg("dim", text),
      warning: (text) => theme.fg("warning", text),
    };
    return new ZobIntroComponent(tui, styles, parsed.options, () => done(undefined));
  }, {
    overlay: true,
    overlayOptions: {
      width: "100%",
      maxHeight: "100%",
      anchor: "center",
      margin: 0,
    },
  });
}

export function registerZobIntroCommand(pi: ExtensionAPI): void {
  const command = {
    description: "Play the custom ZOB pixel-art terminal intro animation. Options: once|loop|fast|slow|5x3|6x3|plain|neon.",
    getArgumentCompletions: zobIntroArgumentCompletions,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await handleZobIntroCommand(pi, args, ctx);
    },
  };

  pi.registerCommand("zob-intro", command);
  pi.registerCommand("zintro", { ...command, description: "Alias for /zob-intro." });
  pi.registerCommand("intro", { ...command, description: "Alias for /zob-intro." });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    if (!ctx.hasUI) return;
    if (!(await shouldPlayFirstRunIntro(ctx.cwd))) {
      appendZobIntroLedger(pi, DEFAULT_ZOB_INTRO_OPTIONS, "auto_skipped");
      return;
    }
    await handleZobIntroCommand(pi, FIRST_RUN_ARGS, ctx);
  });

  pi.on("input", async (event, ctx) => {
    const match = /^\/(zob-intro|zintro|intro)(?:\s+(.*))?$/.exec(event.text.trim());
    if (!match) return { action: "continue" as const };
    await handleZobIntroCommand(pi, match[2] ?? "", ctx);
    return { action: "handled" as const };
  });
}
