# Shared Creator Interface Preview

Development version: `0.3.0-alpha.1`, branch `hub-compatibility`.
The public `0.2.2` release and installed apps are unchanged.

## Changes

- Compact title and context line; no separate hero or introductory section.
- Segoe UI titles and body copy, matching Creator Works MCP.
- Dark neutral background, flat sections, restrained hover backgrounds.
- Left-edge cube tab opens the Creator app switcher. Letter badges distinguish
  Hub (H), MCP (M), and Project Setup (P); Hub adds a gray isometric backplate.
- Keyboard navigation, Escape, outside-click and focus-out dismissal.
- The tab morphs into one left-attached drawer. The logo moves to the top-right
  as its close toggle, with the compact app name on its left. No separate X.
  Page branding fades behind it; a dimmed click-away layer prevents accidental
  activation of project actions underneath. Reduced motion disables transitions.
- New-project fields collapse during creation and after success. A project
  summary and real progress stages take their place. Failure restores the
  original input values; Create another project restores the form.
- Smaller initial window with responsive layouts and compact footer links.
- Repair approval, backup warnings, duplicate-submission guards and confirmed
  Unity Hub restart are preserved.

## Scope

The switcher opens pinned public links only. Creator Hub links to its public
plan while it is in development. MCP links to its releases. URP Converter stays
Coming soon, with no executable action. This UI does not download applications,
discover installed tools, hide standalone navigation based on guessed state,
or claim automatic update support.

Hub installation and eventual hosted-app chrome need a trusted context contract,
not a URL parameter or the presence of a Hub installation. An app opened on its
own must always remain usable. See [the Hub plan](CREATOR-HUB-PLAN.md).

## Verification

- 32 Playwright tests, including the 21 existing workflow tests, pass.
- Browser screenshots checked at 980, 720, 560 and 390 pixels, including long
  paths, repair review, completion, progress and the app switcher.
- Drawer reversal, body stability, short-window scrolling, hidden-item focus
  protection, reduced motion and click-away without click-through are covered.
- Tests use a loopback HTTP server so SVG mask icons are loaded under the same
  origin instead of silently failing in a `file://` fixture.
- 27 Rust unit tests and two release-binary identity tests pass. Four opt-in
  tests that create/repair Unity projects or restart Hub were not rerun.
- Strict Clippy and formatting checks pass. Windows release EXE builds.
- Native visual acceptance remains open: the desktop automation helper failed
  before launch. Browser proof is not a completed native Unity workflow test.

## Assets

Original Creator Works cube artwork reused from the MCP source. Only selected
Lucide SVG controls ship in `src/icons`; the package is a development dependency.
Its complete upstream license is included as `src/icons/LICENSE-lucide`.
