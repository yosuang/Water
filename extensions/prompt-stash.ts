import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const STATE_ENTRY_TYPE = "water-prompt-stash-state";
const WIDGET_KEY = "prompt-stash";
const PREVIEW_LENGTH = 10;
const WIDGET_INDENT = "   ";

type StateEntry = { action: "stash"; prompt: string; timestamp: number } | { action: "clear"; timestamp: number };

function formatPreview(prompt: string): string {
  const chars = Array.from(prompt);
  const preview = chars
    .slice(0, PREVIEW_LENGTH)
    .join("")
    .replace(/\r\n|\r|\n/gu, "↵")
    .replace(/\t/gu, "⇥");

  return chars.length > PREVIEW_LENGTH ? `${preview}…` : preview;
}

function restoreState(ctx: ExtensionContext): string | undefined {
  let restoredPrompt: string | undefined;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;

    const data = entry.data as StateEntry | undefined;
    if (!data) continue;

    if (data.action === "stash" && typeof data.prompt === "string") {
      restoredPrompt = data.prompt;
    } else if (data.action === "clear") {
      restoredPrompt = undefined;
    }
  }

  return restoredPrompt;
}

function formatWidgetText(prompt: string): string {
  return `${WIDGET_INDENT}> Stashed (${formatPreview(prompt)})`;
}

class PromptStashEditor extends CustomEditor {
  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    private readonly getStashedPrompt: () => string | undefined,
    private readonly setStashedPrompt: (prompt: string | undefined) => void,
    private readonly onStashChange: () => void,
  ) {
    super(tui, theme, keybindings);
  }

  override handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("s"))) {
      const currentPrompt = this.getExpandedText();
      if (currentPrompt.length === 0) return;

      this.setStashedPrompt(currentPrompt);
      this.setText("");
      this.onStashChange();
      return;
    }

    if (matchesKey(data, Key.ctrl(Key.up))) {
      const prompt = this.getStashedPrompt();
      if (!prompt || this.getExpandedText().length > 0) return;

      this.setStashedPrompt(undefined);
      this.setText(prompt);
      this.onStashChange();
      return;
    }

    super.handleInput(data);
  }
}

export default function promptStashExtension(pi: ExtensionAPI) {
  let stashedPrompt: string | undefined;

  function persistState(prompt: string | undefined): void {
    const entry: StateEntry = prompt
      ? { action: "stash", prompt, timestamp: Date.now() }
      : { action: "clear", timestamp: Date.now() };
    pi.appendEntry(STATE_ENTRY_TYPE, entry);
  }

  function setStashedPrompt(prompt: string | undefined): void {
    stashedPrompt = prompt;
    persistState(prompt);
  }

  function updateWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    if (!stashedPrompt) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    const prompt = stashedPrompt;
    ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
      render(width) {
        return [truncateToWidth(theme.fg("dim", formatWidgetText(prompt)), width, "")];
      },
      invalidate() {},
    }));
  }

  function restoreStash(ctx: ExtensionContext): void {
    stashedPrompt = restoreState(ctx);
    updateWidget(ctx);
  }

  pi.on("session_start", (_event, ctx) => {
    restoreStash(ctx);
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new PromptStashEditor(
          tui,
          theme,
          keybindings,
          () => stashedPrompt,
          setStashedPrompt,
          () => updateWidget(ctx),
        ),
    );
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreStash(ctx);
  });
}
