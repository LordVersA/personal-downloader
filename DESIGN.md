# Personal Downloader — Design System

**Native and calm.** Solid surfaces, crisp contrast, one blue accent. Feels like a macOS System Settings pane.
Implementation: [`src/styles.css`](src/styles.css). Screens: [`src/index.html`](src/index.html).

## Principles
1. **Solid, not glassy.** Content sits on solid cards. Only the toolbar is frosted, because content scrolls under it.
2. **One colour.** Blue = primary button, progress, focus, links, the selected quality. Green/red only for done/failed.
3. **Farsi is first-class content.** The UI is English, but every user-facing string from the outside world (titles, uploaders, links, errors, paths) has `dir="auto"`, so Farsi reads right-to-left and right-aligns inside its own box. Rows never mirror: thumbnail left, actions right.
4. **Quiet until needed.** Row actions appear on hover/focus; options collapse into one line; the strip only shows while something is happening.
5. **Native feel.** System UI font, light/dark, reduced motion and reduced transparency respected, no network fonts.

## Typography
| Role | Size / weight |
|---|---|
| Body, tabs, buttons | 13 / 400–600 |
| Link field | 15 / 400 |
| Row title | 14 / 500, one line + ellipsis (picker: 15 / 600, two lines) |
| Meta, captions | 12 / 400, secondary colour, `·` separators |
| Group label (Video / Audio) | 11 / 600, uppercase, 0.04em tracking |

Font stack: `Vazirmatn` (bundled, variable, `unicode-range` limited to Arabic script) → system UI font
(SF Pro / Segoe UI Variable / system-ui). Every Farsi glyph gets Vazirmatn and every Latin glyph the system font, even within one title.
Dates are English and relative (Today, Yesterday, Oct 23). Changing numbers use tabular figures. Sentence case everywhere.

## Colour tokens
| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f5f5f7` | `#161618` | Window |
| `--surface` | white | `#222225` | Cards |
| `--line` | ink 8% | white 8% | Card rims, separators |
| `--fill` | grey 12% | grey 24% | Tabs track, buttons, inputs, progress track |
| `--label` / `--label-2` | `#1d1d1f` / 62% | `#f5f5f7` / 60% | Text |
| `--accent` | `#0a66e8` | `#3b8bff` | Actions, progress, focus |
| `--success` / `--danger` | `#1f8a3c` / `#d70015` | `#4ade80` / `#ff6b61` | Saved / failed |

## Pages
Three tabs in a segmented control centred in the 52px toolbar (macOS traffic lights overlay its left side).

```
          [ Download | Library 37% | Settings ]
 ┌───────────────────────────────────────────────┐
 │ Paste a link                        [ Fetch ] │  pasting a URL fetches at once
 └───────────────────────────────────────────────┘
 ┌───────────────────────────────────────────────┐
 │ ↓ Title                      1 of 2 · 37%   › │  strip → Library; "Saved · Show in Finder" 6 s after
 └───────────────────────────────────────────────┘
 Recent                                See all ›     last 3; empty state hint on first run
 after Fetch, the picker card replaces Recent:
 ┌───────────────────────────────────────────────┐
 │ ▭▭▭  Title (2 lines) · uploader · 1:02:05   ✕ │
 │ VIDEO  ◉ Best  1080p60 · vp9          310 MB │  one row per height
 │        ○ 720p  mp4 · h264             120 MB │
 │ AUDIO  ○ MP3 / ○ Original                     │
 │ ▸ All formats (6)                             │
 ├───────────────────────────────────────────────┤
 │ Options ⌃ Metadata · Subtitles   [Download 310 MB] │  sticky to the window bottom
 └───────────────────────────────────────────────┘
```
- **Library:** "In progress" card (only while queued/active/failed), then History with search and Clear.
  Double-click or Enter opens the file; hover shows Open, Show in Finder, Remove (list entry only).
- **Settings:** grouped rows (Downloads / yt-dlp / About), label left, control right.
  yt-dlp shows its version; a system install (pip, Homebrew) gets **Use built-in yt-dlp**, which downloads the standalone build
  the app updates itself. About shows the app version, **Check for updates**, then **Restart to update** once a delta is downloaded.
- Options remember the last choice, including subtitle languages, which are pre-selected when a video has them.
- The Library tab shows the active percent, or a red dot when something failed. An OS notification fires on finish/fail when the window isn't focused.

## Controls
| Control | Size | Look |
|---|---|---|
| Card | radius 12 | Surface + 1px rim |
| Primary key | 36 tall, radius 8 | Accent fill, white 600; spinner while fetching |
| Button | 28 tall, radius 7 | Fill, 500 |
| Icon button | 28 square, radius 7 | Secondary colour, fill on hover |
| Tabs | 26 tall in a 30 track | Selected = surface + small shadow |
| Quality row | radius 8 | Radio · quality · details · size; selected gets accent 12% |
| Chip | 26 tall | Fill; accent when on |
| Progress | 4 tall | Fill track, accent bar; strip uses a 2px bottom line |

## Motion
Picker and options panel rise in (6px, 250ms). Press scales to .96. Progress width transitions 400ms linear.
Empty submit shakes the link field. `prefers-reduced-motion` turns everything off.

## Copy
- Labels are verbs: Fetch, Download, Change, Check now, Show in Finder (Show in folder elsewhere), Try again.
- Errors say what happened and what's possible. Status is a sentence: "yt-dlp 2026.10.10 is up to date".
- No "simply", "just", "easily".

## Accessibility
- Tabs are `role=tab` with `aria-selected`; icon buttons have `aria-label` + tooltip; focus ring is 2px accent.
- Row actions stay visible while the row has focus; history rows are focusable and open on Enter.
- ⌘V / Ctrl+V outside a text field pastes into the link field. Done/failed are words plus colour.
