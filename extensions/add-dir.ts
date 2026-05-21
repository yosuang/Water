import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_ENTRY_TYPE = "water-add-dir-state";
const MESSAGE_TYPE = "water-add-dir";

type StateEntry =
  | { action: "add"; path: string; timestamp: number }
  | { action: "remove"; path: string; timestamp: number }
  | { action: "clear"; timestamp: number };

const addedDirs = new Set<string>();

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

export default function addDirExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    restoreState(ctx);
    updateStatus(ctx);
  });

  pi.registerCommand("add-dir", {
    description: "Add a directory to the LLM-visible workspace context",
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
        ctx.ui.notify(`${message} It will be included in future LLM context.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });
}
