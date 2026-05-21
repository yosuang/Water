import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultPackageManager,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type PackageSource,
  type ResolvedResource,
  SettingsManager,
  type SourceInfo,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  type KeybindingsManager,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const SETTINGS_FILE_NAME = "settings.json";
const MANAGEMENT_EXTENSION_PATH = fileURLToPath(import.meta.url);

type ManagementTab = "tools" | "extensions";
type Theme = ExtensionContext["ui"]["theme"];
type PackageFilter = Exclude<PackageSource, string>;
type SettingsError = { scope: "global" | "project"; error: Error };
type ManagementSettings = {
  activeTools?: string[];
  activeExtensions?: string[];
};

type BaseToggleItem = {
  id: string;
  label: string;
  sourceLabel: string;
  description?: string;
  enabled: boolean;
  initialEnabled: boolean;
  readonlyReason?: string;
  pinned?: boolean;
};

type ToolToggleItem = BaseToggleItem & {
  kind: "tool";
  name: string;
};

type ExtensionToggleItem = BaseToggleItem & {
  kind: "extension";
  resource: ResolvedResource;
};

type ToggleItem = ToolToggleItem | ExtensionToggleItem;

type ManagementResult =
  | {
      confirmed: true;
      tools: ToolToggleItem[];
      extensions: ExtensionToggleItem[];
    }
  | { confirmed: false };

function getSettingsPath(agentDir: string): string {
  return join(agentDir, SETTINGS_FILE_NAME);
}

function getStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

async function readSettingsFile(agentDir: string): Promise<Record<string, unknown>> {
  const settingsPath = getSettingsPath(agentDir);
  try {
    return JSON.parse(await readFile(settingsPath, "utf-8")) as Record<string, unknown>;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function readManagementSettings(agentDir: string): Promise<ManagementSettings> {
  const settings = await readSettingsFile(agentDir);
  return {
    activeTools: getStringArray(settings.activeTools),
    activeExtensions: getStringArray(settings.activeExtensions),
  };
}

async function writeManagementSettings(
  agentDir: string,
  managementSettings: Required<ManagementSettings>,
): Promise<void> {
  const settingsPath = getSettingsPath(agentDir);
  const settings = await readSettingsFile(agentDir);
  settings.activeTools = managementSettings.activeTools;
  settings.activeExtensions = managementSettings.activeExtensions;
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

async function restoreToolState(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));

  try {
    const { activeTools } = await readManagementSettings(getAgentDir());
    if (!activeTools) return;
    pi.setActiveTools(activeTools.filter((tool) => allToolNames.has(tool)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to restore active tools from settings.json:\n${message}`, "warning");
  }
}

function formatSettingsErrors(errors: SettingsError[]): string {
  return errors.map((error) => `${error.scope}: ${error.error.message}`).join("\n");
}

function normalizeDisplayPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function normalizeComparablePath(path: string): string {
  const comparable = normalizeDisplayPath(resolve(path));
  return process.platform === "win32" ? comparable.toLowerCase() : comparable;
}

function isManagementExtension(resource: ResolvedResource): boolean {
  return normalizeComparablePath(resource.path) === normalizeComparablePath(MANAGEMENT_EXTENSION_PATH);
}

function formatSourceInfo(sourceInfo: SourceInfo): string {
  if (sourceInfo.source === "builtin") return "builtin";
  if (sourceInfo.source === "sdk") return "sdk";
  if (sourceInfo.origin === "package") return `${sourceInfo.source} (${sourceInfo.scope})`;
  if (sourceInfo.source === "auto") return `${sourceInfo.scope} auto`;
  return `${sourceInfo.source} (${sourceInfo.scope})`;
}

function formatExtensionSource(resource: ResolvedResource): string {
  const { metadata } = resource;
  if (metadata.origin === "package") return `${metadata.source} (${metadata.scope})`;
  if (metadata.source === "auto") return `${metadata.scope} auto`;
  return `${metadata.source} (${metadata.scope})`;
}

function formatExtensionDisplayName(path: string): string {
  const fileName = basename(path);
  const parentFolder = basename(dirname(path));
  if (fileName === "index.ts" || fileName === "index.js") {
    return `${parentFolder}/${fileName}`;
  }
  if (parentFolder !== "extensions") {
    return `${parentFolder}/${fileName}`;
  }
  return fileName;
}

function getActiveExtensionIds(items: ExtensionToggleItem[]): string[] {
  return items.filter((item) => item.enabled).map((item) => item.label);
}

function buildToolItems(pi: ExtensionAPI): ToolToggleItem[] {
  const activeTools = new Set(pi.getActiveTools());
  return pi
    .getAllTools()
    .map((tool: ToolInfo) => ({
      kind: "tool" as const,
      id: tool.name,
      name: tool.name,
      label: tool.name,
      description: tool.description,
      sourceLabel: formatSourceInfo(tool.sourceInfo),
      enabled: activeTools.has(tool.name),
      initialEnabled: activeTools.has(tool.name),
    }))
    .sort((a, b) => a.sourceLabel.localeCompare(b.sourceLabel) || a.label.localeCompare(b.label));
}

async function buildExtensionItems(
  settingsManager: SettingsManager,
  cwd: string,
  agentDir: string,
): Promise<ExtensionToggleItem[]> {
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await packageManager.resolve();
  return resolved.extensions
    .map((resource) => {
      const pinned = isManagementExtension(resource);
      const enabled = pinned ? true : resource.enabled;
      return {
        kind: "extension" as const,
        id: resource.path,
        resource,
        label: formatExtensionDisplayName(resource.path),
        description: normalizeDisplayPath(resource.path),
        sourceLabel: formatExtensionSource(resource),
        enabled,
        initialEnabled: enabled,
        pinned,
        readonlyReason: pinned
          ? "Management extension cannot disable itself"
          : resource.metadata.scope === "temporary"
            ? "Temporary extension resources cannot be persisted"
            : undefined,
      };
    })
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.sourceLabel.localeCompare(b.sourceLabel) || a.label.localeCompare(b.label);
    });
}

function stripOverridePrefix(pattern: string): string {
  return pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-") ? pattern.slice(1) : pattern;
}

function setExtensionPaths(settingsManager: SettingsManager, scope: "user" | "project", paths: string[]): void {
  if (scope === "project") {
    settingsManager.setProjectExtensionPaths(paths);
  } else {
    settingsManager.setExtensionPaths(paths);
  }
}

function getTopLevelBaseDir(scope: "user" | "project", cwd: string, agentDir: string): string {
  return scope === "project" ? join(cwd, ".pi") : agentDir;
}

function getTopLevelResourcePattern(item: ExtensionToggleItem, cwd: string, agentDir: string): string {
  const scope = item.resource.metadata.scope;
  if (scope === "temporary") return item.resource.path;
  return relative(getTopLevelBaseDir(scope, cwd, agentDir), item.resource.path);
}

function getPackageResourcePattern(item: ExtensionToggleItem): string {
  const baseDir = item.resource.metadata.baseDir ?? dirname(item.resource.path);
  return relative(baseDir, item.resource.path);
}

function isPackageFilter(pkg: PackageSource): pkg is PackageFilter {
  return typeof pkg === "object" && pkg !== null;
}

function hasPackageFilters(pkg: PackageFilter): boolean {
  return ["extensions", "skills", "prompts", "themes"].some((key) => pkg[key as keyof PackageFilter] !== undefined);
}

function toggleTopLevelExtension(
  settingsManager: SettingsManager,
  item: ExtensionToggleItem,
  enabled: boolean,
  cwd: string,
  agentDir: string,
): boolean {
  const scope = item.resource.metadata.scope;
  if (scope === "temporary") return false;

  const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
  const current = [...(settings.extensions ?? [])];
  const pattern = getTopLevelResourcePattern(item, cwd, agentDir);
  const updated = current.filter((entry) => stripOverridePrefix(entry) !== pattern);
  updated.push(`${enabled ? "+" : "-"}${pattern}`);
  setExtensionPaths(settingsManager, scope, updated);
  return true;
}

function togglePackageExtension(
  settingsManager: SettingsManager,
  item: ExtensionToggleItem,
  enabled: boolean,
): boolean {
  const scope = item.resource.metadata.scope;
  if (scope === "temporary") return false;

  const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
  const packages = [...(settings.packages ?? [])];
  const packageIndex = packages.findIndex((pkg) => {
    const source = typeof pkg === "string" ? pkg : pkg.source;
    return source === item.resource.metadata.source;
  });

  if (packageIndex === -1) return false;

  const currentPackage = packages[packageIndex];
  const packageFilter: PackageFilter = isPackageFilter(currentPackage)
    ? { ...currentPackage }
    : { source: currentPackage };
  const current = [...(packageFilter.extensions ?? [])];
  const pattern = getPackageResourcePattern(item);
  const updated = current.filter((entry) => stripOverridePrefix(entry) !== pattern);
  updated.push(`${enabled ? "+" : "-"}${pattern}`);
  packageFilter.extensions = updated;
  packages[packageIndex] = hasPackageFilters(packageFilter) ? packageFilter : packageFilter.source;

  if (scope === "project") {
    settingsManager.setProjectPackages(packages);
  } else {
    settingsManager.setPackages(packages);
  }
  return true;
}

async function applyExtensionChanges(
  settingsManager: SettingsManager,
  items: ExtensionToggleItem[],
  cwd: string,
  agentDir: string,
): Promise<number> {
  let applied = 0;

  for (const item of items) {
    if (item.enabled === item.initialEnabled) continue;
    const changed =
      item.resource.metadata.origin === "top-level"
        ? toggleTopLevelExtension(settingsManager, item, item.enabled, cwd, agentDir)
        : togglePackageExtension(settingsManager, item, item.enabled);
    if (changed) applied += 1;
  }

  await settingsManager.flush();
  const errors = settingsManager.drainErrors();
  if (errors.length > 0) {
    throw new Error(formatSettingsErrors(errors));
  }

  return applied;
}

function cloneToolItems(items: ToolToggleItem[]): ToolToggleItem[] {
  return items.map((item) => ({ ...item }));
}

function cloneExtensionItems(items: ExtensionToggleItem[]): ExtensionToggleItem[] {
  return items.map((item) => ({ ...item }));
}

function countEnabled(items: ToggleItem[]): number {
  return items.filter((item) => item.enabled).length;
}

function countChanged(items: ToggleItem[]): number {
  return items.filter((item) => item.enabled !== item.initialEnabled).length;
}

function padAnsi(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

class ManagementDialog implements Component {
  private activeTab: ManagementTab = "tools";
  private selectedByTab: Record<ManagementTab, number> = { tools: 0, extensions: 0 };

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly toolItems: ToolToggleItem[],
    private readonly extensionItems: ExtensionToggleItem[],
    private readonly done: (result: ManagementResult) => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.shift(Key.tab))) {
      this.switchTab(-1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.tab) || this.keybindings.matches(data, "tui.input.tab")) {
      this.switchTab(1);
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done({ confirmed: false });
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.moveSelection(-8);
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.moveSelection(8);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.space) || data === " ") {
      this.toggleSelected();
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      this.done({
        confirmed: true,
        tools: cloneToolItems(this.toolItems),
        extensions: cloneExtensionItems(this.extensionItems),
      });
    }
  }

  render(width: number): string[] {
    const boxWidth = Math.max(Math.min(width, 64), Math.floor(width * 0.86));
    const leftPad = Math.floor((width - boxWidth) / 2);
    const rightPad = Math.max(0, width - boxWidth - leftPad);
    const innerWidth = Math.max(20, boxWidth - 2);
    const maxRows = Math.max(12, Math.min(process.stdout.rows ?? 28, 32));
    const listHeight = Math.max(4, maxRows - 9);
    const lines: string[] = [];

    lines.push(this.borderLine(innerWidth, "top"));
    lines.push(this.frameLine(this.theme.fg("accent", this.theme.bold(" Management ")), innerWidth));
    lines.push(this.frameLine(this.renderTabs(innerWidth), innerWidth));
    lines.push(
      this.frameLine(
        this.theme.fg("dim", "Tab/Shift+Tab switch · ↑↓ select · Space toggle · Enter apply · Esc cancel"),
        innerWidth,
      ),
    );
    lines.push(this.separatorLine(innerWidth));
    lines.push(...this.renderList(innerWidth, listHeight));
    lines.push(this.separatorLine(innerWidth));
    lines.push(this.frameLine(this.renderSummary(), innerWidth));
    lines.push(this.borderLine(innerWidth, "bottom"));

    return lines.map((line) => `${" ".repeat(leftPad)}${padAnsi(line, boxWidth)}${" ".repeat(rightPad)}`);
  }

  private switchTab(direction: 1 | -1): void {
    const tabs: ManagementTab[] = ["tools", "extensions"];
    const current = tabs.indexOf(this.activeTab);
    this.activeTab = tabs[(current + direction + tabs.length) % tabs.length]!;
    this.clampSelection();
  }

  private getCurrentItems(): ToggleItem[] {
    return this.activeTab === "tools" ? this.toolItems : this.extensionItems;
  }

  private getSelectedIndex(): number {
    return this.selectedByTab[this.activeTab];
  }

  private setSelectedIndex(index: number): void {
    this.selectedByTab[this.activeTab] = index;
  }

  private clampSelection(): void {
    const items = this.getCurrentItems();
    const maxIndex = Math.max(0, items.length - 1);
    this.setSelectedIndex(Math.max(0, Math.min(this.getSelectedIndex(), maxIndex)));
  }

  private moveSelection(delta: number): void {
    const items = this.getCurrentItems();
    if (items.length === 0) return;
    const next = Math.max(0, Math.min(this.getSelectedIndex() + delta, items.length - 1));
    this.setSelectedIndex(next);
  }

  private toggleSelected(): void {
    const items = this.getCurrentItems();
    const selected = items[this.getSelectedIndex()];
    if (!selected || selected.readonlyReason) return;
    selected.enabled = !selected.enabled;
  }

  private renderTabs(width: number): string {
    const tabs: Array<{ id: ManagementTab; label: string; items: ToggleItem[] }> = [
      { id: "tools", label: "Tools", items: this.toolItems },
      { id: "extensions", label: "Extensions", items: this.extensionItems },
    ];

    return truncateToWidth(
      tabs
        .map((tab) => {
          const text = ` ${tab.label} ${countEnabled(tab.items)}/${tab.items.length} `;
          if (tab.id === this.activeTab)
            return this.theme.bg("selectedBg", this.theme.fg("accent", this.theme.bold(text)));
          return this.theme.fg("muted", text);
        })
        .join(" "),
      width,
      "",
    );
  }

  private renderList(width: number, maxVisible: number): string[] {
    const items = this.getCurrentItems();
    if (items.length === 0) return [this.frameLine(this.theme.fg("muted", "No items found."), width)];

    const selectedIndex = this.getSelectedIndex();
    const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
    const endIndex = Math.min(startIndex + maxVisible, items.length);
    const lines: string[] = [];

    for (let i = startIndex; i < endIndex; i += 1) {
      const item = items[i];
      if (!item) continue;
      lines.push(this.frameLine(this.renderItem(item, i === selectedIndex, width), width));
    }

    for (let i = lines.length; i < maxVisible; i += 1) {
      lines.push(this.frameLine("", width));
    }

    if (startIndex > 0 || endIndex < items.length) {
      lines.push(this.frameLine(this.theme.fg("dim", `${selectedIndex + 1}/${items.length}`), width));
    }

    return lines;
  }

  private renderItem(item: ToggleItem, selected: boolean, width: number): string {
    const cursor = selected ? this.theme.fg("accent", "›") : " ";
    const icon = item.enabled ? this.theme.fg("success", "●") : this.theme.fg("dim", "○");
    const changed = item.enabled !== item.initialEnabled ? this.theme.fg("warning", "*") : " ";
    const label = selected ? this.theme.bold(item.label) : item.label;
    const source = this.theme.fg("dim", item.sourceLabel);
    const readonly = item.readonlyReason ? this.theme.fg("warning", " readonly") : "";
    const content = `${cursor} ${icon}${changed} ${label} ${source}${readonly}`;
    return truncateToWidth(content, width, "…");
  }

  private renderSummary(): string {
    const toolChanges = countChanged(this.toolItems);
    const extensionChanges = countChanged(this.extensionItems);
    const total = toolChanges + extensionChanges;
    if (total === 0) return this.theme.fg("dim", "No pending changes.");
    return this.theme.fg(
      "warning",
      `${total} pending change(s): ${toolChanges} tool(s), ${extensionChanges} extension(s).`,
    );
  }

  private frameLine(content: string, innerWidth: number): string {
    return `${this.theme.fg("borderMuted", "│")}${padAnsi(content, innerWidth)}${this.theme.fg("borderMuted", "│")}`;
  }

  private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.theme.fg("borderMuted", `${left}${"─".repeat(innerWidth)}${right}`);
  }

  private separatorLine(innerWidth: number): string {
    return this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`);
  }
}

export default function managementExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await restoreToolState(pi, ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreToolState(pi, ctx);
  });

  pi.registerCommand("management", {
    description: "Manage enabled tools and extensions",
    handler: async (_args, ctx) => {
      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
      const initialSettingsErrors = settingsManager.drainErrors();
      if (initialSettingsErrors.length > 0) {
        ctx.ui.notify(`Settings warning:\n${formatSettingsErrors(initialSettingsErrors)}`, "warning");
      }

      const toolItems = buildToolItems(pi);
      const extensionItems = await buildExtensionItems(settingsManager, ctx.cwd, agentDir);

      const result = await ctx.ui.custom<ManagementResult>(
        (tui, theme, keybindings, done) =>
          new ManagementDialog(tui, theme, keybindings, toolItems, extensionItems, done),
        {
          overlay: true,
          overlayOptions: {
            // Use a full-width overlay and center the dialog internally. This avoids
            // pi-tui overlay compositing drifting when the overlay's left edge cuts
            // through a CJK wide character in the underlying main window.
            width: "100%",
            maxHeight: "86%",
            anchor: "center",
          },
        },
      );

      if (!result.confirmed) return;

      const enabledTools = result.tools.filter((tool) => tool.enabled).map((tool) => tool.name);
      const enabledExtensions = getActiveExtensionIds(result.extensions);
      pi.setActiveTools(enabledTools);

      const extensionChanges = countChanged(result.extensions);
      if (extensionChanges === 0) {
        try {
          await writeManagementSettings(agentDir, { activeTools: enabledTools, activeExtensions: enabledExtensions });
          const toolChanges = countChanged(result.tools);
          ctx.ui.notify(toolChanges > 0 ? `Applied ${toolChanges} tool change(s).` : "No changes to apply.", "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Failed to write management settings:\n${message}`, "error");
        }
        return;
      }

      try {
        const appliedExtensions = await applyExtensionChanges(settingsManager, result.extensions, ctx.cwd, agentDir);
        await writeManagementSettings(agentDir, { activeTools: enabledTools, activeExtensions: enabledExtensions });
        ctx.ui.notify(`Applied ${appliedExtensions} extension change(s). Reloading...`, "info");
        await ctx.reload();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to apply extension changes:\n${message}`, "error");
      }
    },
  });
}
