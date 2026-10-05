import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral";
export const impoTheme = defineTheme({
  name: "impo",
  extends: neutralTheme,
  color: { accent: "#264d3d", neutralStyle: "warm" },
  typography: {
    scale: { base: 16, ratio: 1.2 },
    body: {
      family: "-apple-system",
      fallbacks: 'BlinkMacSystemFont, "Segoe UI", sans-serif',
    },
    heading: { family: "Georgia", fallbacks: '"Times New Roman", serif' },
  },
  radius: { base: 5, multiplier: 1 },
  components: {
    button: {
      base: {
        minHeight: "var(--impo-control-height)",
        minWidth: "var(--impo-control-height)",
      },
    },
    "text-input": {
      base: {
        minHeight: "var(--impo-control-height)",
        paddingInline: "var(--spacing-3)",
      },
    },
    "dialog-header": { base: { flexShrink: "0" } },
    "chat-composer": {
      base: {
        "--focus-outline-offset": "calc(-1 * var(--impo-line))",
      },
    },
    "date-input": {
      base: { minHeight: "var(--impo-control-height)" },
    },
  },
  tokens: {
    "--color-background-body": "#f4eee3",
    "--color-background-surface": "#fcf8ee",
    "--color-background-card": "#fcf8ee",
    "--color-background-popover": "#fcf8ee",
    "--color-background-muted": "#eee7d8",
    "--color-text-primary": "#293d2e",
    "--color-text-secondary": "#62624c",
    "--color-border": "#d4c7ab",
    "--color-border-emphasized": "#948a76",
    "--color-accent": "#264d3d",
    "--color-on-accent": "#fcf8ee",
    "--color-text-accent": "#264d3d",
    "--color-icon-accent": "#264d3d",
    "--color-accent-muted": "#dae3d0",
  },
  localTokens: {
    "--impo-sage": "#c4d4b8",
    "--impo-peach": "#f7d6a8",
    "--impo-reading-width": "800px",
    "--impo-page-width": "1080px",
    "--impo-sidebar-width": "240px",
    "--impo-line": "1px",
    "--impo-control-height": "44px",
    "--impo-mobile-header-height": "68px",
    "--impo-caption-size": "14px",
    "--impo-field-min-width": "224px",
    "--impo-settings-width": "680px",
    "--impo-onboarding-width": "560px",
    "--impo-focus-width": "2px",
    "--impo-focus-offset": "3px",
  },
});
