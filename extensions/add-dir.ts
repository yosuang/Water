import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  CombinedAutocompleteProvider,
} from "@earendil-works/pi-tui";

const STATE_ENTRY_TYPE = "water-add-dir-state";
const MESSAGE_TYPE = "water-add-dir";
const MAX_ADDED_AUTOCOMPLETE_ITEMS = 20;
const MAX_TOTAL_AUTOCOMPLETE_ITEMS = 40;

type StateEntry =
  | { action: "add"; path: string; timestamp: number }
  | { action: "remove"; path: string; timestamp: number }
  | { action: "clear"; timestamp: number };

type ParsedAtPrefix = {
  prefix: string;
  query: string;
  isQuotedPrefix: boolean;
};

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

const addedDirs = new Set<string>();
let fdPath: string | undefined;

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

async function resolveDirectory(input: string, cwd: string): Promise<string> {
  const cleaned = stripMatchingQuotes(input);
  if (!cleaned) throw new Error("Please provide a directory path.");

  const expanded = expandHome(cleaned);
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const stats = await stat(absolute).catch(() => null);
  if (!stats) throw new Error(`Path not found: ${absolute}`);
  if (!stats.isDirectory()) throw new Error(`Not a directory: ${absolute}`);

  return realpath(absolute).catch(() => absolute);
}

function restoreState(ctx: ExtensionContext): void {
  addedDirs.clear();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    const data = entry.data as StateEntry | undefined;
    if (!data) continue;
    if (data.action === "add") addedDirs.add(data.path);
    if (data.action === "remove") addedDirs.delete(data.path);
    if (data.action === "clear") addedDirs.clear();
  }
}

function formatDirs(): string {
  return [...addedDirs].map((dir) => `- ${dir}`).join("\n");
}

function formatCurrentDirs(): string {
  return addedDirs.size === 0
    ? "Current additional working directories: none."
    : `Current additional working directories:\n${formatDirs()}`;
}

function formatContextUpdate(message: string): string {
  return `${message}\n\n${formatCurrentDirs()}`;
}

function updateStatus(ctx: ExtensionContext): void {
  ctx.ui.setStatus("add-dir", addedDirs.size > 0 ? `dirs: ${addedDirs.size}` : undefined);
}

function sendContextMessage(pi: ExtensionAPI, content: string, details?: unknown): void {
  pi.sendMessage({
    customType: MESSAGE_TYPE,
    content,
    display: true,
    details,
  });
}

function splitCommand(args: string): { command: string; rest: string } {
  const trimmed = args.trim();
  if (!trimmed) return { command: "", rest: "" };
  const match = trimmed.match(/^(\S+)\s*([\s\S]*)$/u);
  return { command: match?.[1] ?? trimmed, rest: match?.[2] ?? "" };
}

function toDisplayPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function findLastDelimiter(text: string): number {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (PATH_DELIMITERS.has(text[i] ?? "")) return i;
  }
  return -1;
}

function findUnclosedQuoteStart(text: string): number | undefined {
  let quoteStart: number | undefined;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '"') continue;
    quoteStart = quoteStart === undefined ? i : undefined;
  }
  return quoteStart;
}

function isTokenStart(text: string, index: number): boolean {
  return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

function parseAtPrefix(textBeforeCursor: string): ParsedAtPrefix | undefined {
  const quoteStart = findUnclosedQuoteStart(textBeforeCursor);
  if (quoteStart !== undefined && quoteStart > 0 && textBeforeCursor[quoteStart - 1] === "@") {
    const atIndex = quoteStart - 1;
    if (isTokenStart(textBeforeCursor, atIndex)) {
      const prefix = textBeforeCursor.slice(atIndex);
      return { prefix, query: prefix.slice(2), isQuotedPrefix: true };
    }
  }

  const lastDelimiterIndex = findLastDelimiter(textBeforeCursor);
  const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
  if (textBeforeCursor[tokenStart] !== "@") return undefined;

  const prefix = textBeforeCursor.slice(tokenStart);
  return {
    prefix,
    query: prefix.startsWith('@"') ? prefix.slice(2) : prefix.slice(1),
    isQuotedPrefix: prefix.startsWith('@"'),
  };
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.error === undefined || result.error === null;
}

function getFdPath(): string {
  if (fdPath) return fdPath;

  const binary = process.platform === "win32" ? "fd.exe" : "fd";
  const managedFdPath = join(getAgentDir(), "bin", binary);
  if (existsSync(managedFdPath)) {
    fdPath = managedFdPath;
  } else if (commandExists("fd")) {
    fdPath = "fd";
  } else if (commandExists("fdfind")) {
    fdPath = "fdfind";
  } else {
    fdPath = "fd";
  }

  return fdPath;
}

function buildAtCompletionValue(displayPath: string, isDirectory: boolean, isQuoted: boolean): string {
  const path = isDirectory && !displayPath.endsWith("/") ? `${displayPath}/` : displayPath;
  if (isQuoted || /\s/u.test(path)) return `@"${path}"`;
  return `@${path}`;
}

function parseCompletionValue(value: string): { path: string; isQuoted: boolean } {
  let path = value.startsWith("@") ? value.slice(1) : value;
  let isQuoted = false;

  if (path.startsWith('"')) {
    isQuoted = true;
    path = path.slice(1);
    if (path.endsWith('"')) path = path.slice(0, -1);
  }

  return { path, isQuoted };
}

function normalizeComparablePath(value: string): string {
  const normalized = toDisplayPath(value).replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function atPrefixForRoot(parsed: ParsedAtPrefix, root: string): string | undefined {
  const expandedQuery = expandHome(parsed.query);
  if (!isAbsolute(expandedQuery)) return parsed.prefix;

  const rawDisplayQuery = toDisplayPath(expandedQuery);
  const displayQuery = rawDisplayQuery.replace(/\/+$/u, "");
  const displayRoot = toDisplayPath(root).replace(/\/+$/u, "");
  const comparableQuery = normalizeComparablePath(displayQuery);
  const comparableRoot = normalizeComparablePath(displayRoot);

  if (comparableQuery === comparableRoot) {
    return parsed.isQuotedPrefix ? '@"' : "@";
  }
  if (!comparableQuery.startsWith(`${comparableRoot}/`)) return undefined;

  const relativeQuery = rawDisplayQuery.slice(displayRoot.length + 1);
  return parsed.isQuotedPrefix ? `@"${relativeQuery}` : `@${relativeQuery}`;
}

function linesWithPrefix(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  oldPrefix: string,
  newPrefix: string,
): { lines: string[]; cursorCol: number } {
  const nextLines = [...lines];
  const line = nextLines[cursorLine] ?? "";
  const prefixStart = cursorCol - oldPrefix.length;
  nextLines[cursorLine] = `${line.slice(0, prefixStart)}${newPrefix}${line.slice(cursorCol)}`;
  return { lines: nextLines, cursorCol: prefixStart + newPrefix.length };
}

function absoluteAutocompleteItem(item: AutocompleteItem, root: string, parsed: ParsedAtPrefix): AutocompleteItem {
  const completion = parseCompletionValue(item.value);
  const expandedPath = expandHome(completion.path);
  const isDirectory = item.label.endsWith("/");
  const absolutePath = isAbsolute(expandedPath) ? expandedPath : resolve(root, expandedPath);
  const displayPath = toDisplayPath(absolutePath) + (isDirectory ? "/" : "");
  const relativeDescription = item.description ?? toDisplayPath(completion.path);

  return {
    ...item,
    value: buildAtCompletionValue(displayPath, isDirectory, parsed.isQuotedPrefix || completion.isQuoted),
    label: item.label || basename(completion.path),
    description: `${toDisplayPath(root)} → ${relativeDescription}`,
  };
}

function mergeAutocompleteItems(
  addedItems: AutocompleteItem[],
  baseItems: AutocompleteItem[] | undefined,
): AutocompleteItem[] {
  const seen = new Set<string>();
  const merged: AutocompleteItem[] = [];

  for (const item of [...addedItems, ...(baseItems ?? [])]) {
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    merged.push(item);
    if (merged.length >= MAX_TOTAL_AUTOCOMPLETE_ITEMS) break;
  }

  return merged;
}

async function getSuggestionsForAddedDir(
  dir: string,
  parsed: ParsedAtPrefix,
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  options: { signal: AbortSignal; force?: boolean },
): Promise<AutocompleteItem[]> {
  const prefix = atPrefixForRoot(parsed, dir);
  if (prefix === undefined) return [];

  const provider = new CombinedAutocompleteProvider([], dir, getFdPath());
  const patched = linesWithPrefix(lines, cursorLine, cursorCol, parsed.prefix, prefix);
  const suggestions = await provider
    .getSuggestions(patched.lines, cursorLine, patched.cursorCol, options)
    .catch(() => null);

  if (options.signal.aborted || !suggestions) return [];
  return suggestions.items
    .slice(0, MAX_ADDED_AUTOCOMPLETE_ITEMS)
    .map((item) => absoluteAutocompleteItem(item, dir, parsed));
}

function createAddedDirsAutocompleteProvider(current: AutocompleteProvider): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const currentLine = lines[cursorLine] ?? "";
      const parsed = parseAtPrefix(currentLine.slice(0, cursorCol));
      if (!parsed || addedDirs.size === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const [baseSuggestions, addedItemsByDir] = await Promise.all([
        current.getSuggestions(lines, cursorLine, cursorCol, options).catch(() => null),
        Promise.all(
          [...addedDirs].map((dir) => getSuggestionsForAddedDir(dir, parsed, lines, cursorLine, cursorCol, options)),
        ),
      ]);

      const addedItems = addedItemsByDir.flat().slice(0, MAX_ADDED_AUTOCOMPLETE_ITEMS);
      if (options.signal.aborted || addedItems.length === 0) return baseSuggestions;

      return {
        prefix: parsed.prefix,
        items: mergeAutocompleteItems(addedItems, baseSuggestions?.items),
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

export default function addDirExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    restoreState(ctx);
    updateStatus(ctx);
    ctx.ui.addAutocompleteProvider(createAddedDirsAutocompleteProvider);
  });

  pi.registerCommand("add-dir", {
    description: "Add a directory to the LLM-visible workspace context and @ file completion",
    getArgumentCompletions: (prefix) => {
      if (prefix.trim().length > 0) return null;
      return [
        {
          value: "--list",
          label: "--list",
          description: "Show added directories",
        },
        {
          value: "--clear",
          label: "--clear",
          description: "Remove all added directories",
        },
        {
          value: "--remove ",
          label: "--remove",
          description: "Remove one added directory",
        },
      ];
    },
    handler: async (args, ctx) => {
      const { command, rest } = splitCommand(args);

      if (command === "--list" || command === "list") {
        const content =
          addedDirs.size === 0
            ? "No additional working directories have been added."
            : `Current additional working directories:\n${formatDirs()}`;
        ctx.ui.notify(content, "info");
        return;
      }

      if (command === "--clear" || command === "clear") {
        if (addedDirs.size === 0) {
          ctx.ui.notify("No additional working directories to clear.", "info");
          return;
        }
        const previous = [...addedDirs];
        addedDirs.clear();
        pi.appendEntry(STATE_ENTRY_TYPE, {
          action: "clear",
          timestamp: Date.now(),
        } satisfies StateEntry);
        updateStatus(ctx);
        const message = `Cleared additional working directories. Removed:\n${previous.map((dir) => `- ${dir}`).join("\n")}`;
        sendContextMessage(pi, formatContextUpdate(message), {
          directories: [],
        });
        ctx.ui.notify("Cleared additional working directories.", "info");
        return;
      }

      if (command === "--remove" || command === "remove") {
        try {
          const dir = await resolveDirectory(rest, ctx.cwd);
          if (!addedDirs.has(dir)) {
            ctx.ui.notify(`Directory was not added: ${dir}`, "warning");
            return;
          }
          addedDirs.delete(dir);
          pi.appendEntry(STATE_ENTRY_TYPE, {
            action: "remove",
            path: dir,
            timestamp: Date.now(),
          } satisfies StateEntry);
          updateStatus(ctx);
          const message = `Removed ${dir} from additional working directories.`;
          sendContextMessage(pi, formatContextUpdate(message), {
            path: dir,
            directories: [...addedDirs],
          });
          ctx.ui.notify(message, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        }
        return;
      }

      let rawPath = args.trim();
      if (!rawPath && ctx.hasUI) {
        rawPath = (await ctx.ui.input("Add directory to workspace context:", ctx.cwd)) ?? "";
      }

      try {
        const dir = await resolveDirectory(rawPath, ctx.cwd);
        if (addedDirs.has(dir)) {
          ctx.ui.notify(`${dir} is already an additional working directory.`, "info");
          return;
        }

        addedDirs.add(dir);
        pi.appendEntry(STATE_ENTRY_TYPE, {
          action: "add",
          path: dir,
          timestamp: Date.now(),
        } satisfies StateEntry);
        updateStatus(ctx);

        const message = `Added ${dir} as an additional working directory for this session.`;
        sendContextMessage(pi, formatContextUpdate(message), {
          path: dir,
          directories: [...addedDirs],
        });
        ctx.ui.notify(`${message} It will be included in future LLM context and @ file completion.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });
}
