# ternlatex

Live LaTeX → PDF editing inside [Tern](https://stencil.so/tern), with omp as the writing assistant.
Save a `.tex` file and the PDF in the viewer updates in about a second, at the same scroll position.
Ask omp for a table, a proofread or a style change and watch it land.

```
┌────────────────┬─────────────────────┐
│ editor (.tex)  │                     │
│                │  live PDF viewer    │
├────────────────┤  (browser block)    │
│ omp            │                     │
│                │                     │
├────────────────┤                     │
│ ternlatex dev  │                     │
└────────────────┴─────────────────────┘
```

ternlatex is a [Bun](https://bun.sh) package. On first use it downloads pinned versions of Tectonic
(XeTeX), pandoc and latexdiff and checks them against recorded SHA-256 sums. TeX packages come from a
pinned TeX Live 2022 bundle, also fetched on first use.

## Install

### From Tern

In Tern, open Preferences › Plugins › Install… and enter `github.com/f0t1h/tern-latex`. Or run
`tern plugin install github.com/f0t1h/tern-latex` in a terminal block. This repository is the plugin, and
the plugin is all of ternlatex: it runs ternlatex from its own folder.

The plugin needs [Bun](https://bun.sh). Without it, the plugin says so (blocks in a ternlatex project show
**ternlatex needs Bun** in the status line) and offers **Install Bun**, which opens a new tab running Bun's
official installer. The first use fetches ternlatex's dependencies with Bun, which takes a few seconds;
Bun keeps them in its own cache. Then open the palette and type `ternlatex`:

- **Start ternlatex here**: opens a new tab running `ternlatex dev` for the focused block's project (the
  folder with `ternlatex.toml` above it).
- **New LaTeX project here… (or adopt this folder)**: in an empty folder, creates an article project; in a
  folder that already has your LaTeX (a cloned Overleaf project, say), adopts it in place
  (`ternlatex import`). Then starts it.
- **Add ternlatex to PATH**: puts a `ternlatex` command into Bun's bin folder (`~/.bun/bin`, which Bun's
  installer puts on your `PATH`), so you can run ternlatex in any terminal. If that folder isn't on your
  `PATH`, the plugin's message says how to add it.
- **Copy ternlatex path**: copies the command that runs this ternlatex, so you can run it in a terminal
  block.
- **Install Bun**: opens a new tab running Bun's installer.
- **Uninstall ternlatex**: opens a new tab running `ternlatex uninstall` (see [Uninstall](#uninstall)).

To update, remove the plugin in Preferences › Plugins and install it again, or run
`tern plugin install --force github.com/f0t1h/tern-latex`.

### From a terminal

With [Bun](https://bun.sh) installed, run:

```sh
bun add -g github:f0t1h/tern-latex
ternlatex doctor --warm   # downloads tectonic, pandoc, latexdiff and the templates' TeX packages (once)
```

This installs ternlatex globally with Bun, so the `ternlatex` command is on your `PATH` (Bun's installer
puts Bun's bin folder, `~/.bun/bin`, there). Run the `bun add -g` line again to update. Without `--warm`,
each tool and TeX package is downloaded the first time a build needs it. Tools come from their GitHub
releases; TeX packages come from `data1b.fullyjustified.net` (the `bundle` setting).

Inside Tern, `ternlatex dev` connects this ternlatex to Tern by itself. If the plugin is also installed
from Tern, the plugin's own commands keep running the plugin's copy, and `dev` warns when the two versions
differ.

### Requirements and platforms

- Required: [Bun](https://bun.sh) 1.4.2 or newer, and git.
- Optional: omp (the writing assistant, proofreading, rewrites, dictation); Tern (any browser works as
  the viewer); perl, for redlines (macOS and most Linux distributions ship it); chktex and latexmk.
- macOS, Linux and Windows. Windows is supported, but less tested than macOS and Linux.

### Uninstall

Run `ternlatex uninstall`, or **Uninstall ternlatex** in Tern's palette. It lists what it will remove, with
sizes, and asks first: the Tern plugin and its data folder, the `ternlatex` command **Add ternlatex to
PATH** (or `install-cli`) put on your `PATH`, a `bun add -g` install, the cache (tools and TeX packages)
and ternlatex's data folder. Keys **Use LaTeX editing keys** bound go back to what they were.
`--keep-cache` keeps the cache; `--yes` skips the question.

Projects are left as they are. Each keeps `ternlatex.toml`, `build/` and the `refs/ternlatex/checkpoints`
git ref; `ternlatex uninstall` ends with the commands that remove them. A running `ternlatex dev` keeps
running until you stop it.

## Quick start

```sh
ternlatex init paper          # article template; also --template report, letter or beamer
cd paper && ternlatex dev     # in a Tern block: lays out editor | viewer, omp and the dev log
```

Outside Tern, `ternlatex dev --open` opens the viewer in your browser. The port stays the same for a
project, so an open viewer reconnects by itself after a restart.

Press Ctrl+C in the dev block to stop the server; the editor, viewer and omp blocks stay open. From any
other block, `ternlatex stop` does the same. `ternlatex restart` restarts the server in its own block and
picks up changes to `ternlatex.toml` and an updated ternlatex. A running omp block is reused across
restarts. A new omp block continues the project's latest omp session; type `/new` in omp to start a fresh
one.

To bring in existing work:

```sh
ternlatex import ~/thesis             # adopt a .tex project in place (every root file becomes a document)
ternlatex import report.docx report   # convert with pandoc (also .odt .md .html .rtf .epub)
```

After a conversion, run `/skill:import-cleanup` in omp to turn pandoc's output into clean LaTeX.

### Overleaf and other shared repositories

Clone the project yourself, then adopt it. For Overleaf, the clone URL is in the project's **Integrations ›
Git** (a premium Overleaf feature; the password is a Git token from your Overleaf account settings):

```sh
git clone https://git.overleaf.com/<project-id> paper
cd paper && ternlatex import . && ternlatex dev
```

Adopting a repository that already has commits changes nothing in it. ternlatex's own files
(`ternlatex.toml`, `build/`, `style/ternlatex-review.tex`) are listed in the clone's local
`.git/info/exclude`, not in `.gitignore`, so they stay untracked and are never committed or pushed, and
`git status` stays clean. Save checkpoints live on their own ref, which `git push` leaves behind. Commit,
pull and push your edits as usual. Overleaf compiles with pdfLaTeX by default and ternlatex with Tectonic
(XeLaTeX); if the document needs pdfLaTeX, set `engine = "latexmk"` and `latexmk_args = ["-pdf"]` to use
your own TeX Live.

Co-authors keep editing in Overleaf, so omp works on the latest version: before omp's first edit of each
request, ternlatex fetches from Overleaf and rebases the clone onto it (your commits on top, uncommitted
edits to other files kept). When that brought changes, omp's edit is refused once with the files that
changed, so it reads them again before writing. It never pushes, and it leaves the clone alone (and omp
tells you) when you have uncommitted edits to a file Overleaf also changed, or a commit of yours
conflicts with Overleaf's. `ternlatex pull` does the same by hand. Other remotes (GitHub, a co-author's
server) are not pulled.

## Using ternlatex

Keys are written for macOS. On Windows and Linux, ⌘ is Ctrl and ⌥ is Alt: ⌘⌥J is Ctrl+Alt+J.

### Viewer

- Every save rebuilds. When a build fails (a co-author's figure or section not pushed yet, a package not
  added, a typo in a macro), ternlatex builds it again past the errors and shows that **partial PDF**:
  missing figures and `\input` files appear as labelled placeholder boxes, and the toolbar says
  **⚠ Built with errors**. The banner lists the errors; click one to open its file at that line, or
  **Fix** to hand it to omp (**Fix all with omp** sends the whole list). When even that fails, the
  viewer keeps the last good PDF. Set `partial = false` to always keep the last good PDF instead.
- **⌘-click** on the PDF jumps to the source line (SyncTeX).
- Zoom with ⌘+, ⌘− and ⌘0, or with the toolbar. `#page=N` in the URL opens a page.
- **Search** with **⌘F**, `/` or **⌕**. It searches the typeset text and the LaTeX source at once and
  marks every place on the PDF. Matching tolerates accents, ligatures, line-end hyphenation and words a
  little apart or in another order. A typo in your query finds the word when the document doesn't have
  what you typed; when it does, other words count only as its likely misspellings in the document (a
  single "fsat" where the text says "fast", marked **possible typo**; never "last"). Likely slips cost
  least: a neighbouring key, a missed or extra letter, two letters swapped. In the source it reads the
  prose (section titles, captions, table cells, footnotes, macro arguments, citation keys) and the math,
  never the preamble, comments, labels, package options or file names. Math matches by command and by
  symbol: `\sum`, `∑` and the word "sum" all find the typeset ∑, `\le` finds ≤, `\Gamma` finds Γ, and
  `\frac` (no glyph of its own) finds where fractions are written. A query word with a backslash only
  matches math. Text only in the source (a citation key, `\frac`) is marked on the lines SyncTeX gives
  for it. Enter and ⇧Enter go to the next and previous place, **⌘Enter** opens the source, and the list
  shows each place with its page and `file:line`. Results follow rebuilds.
- Toolbar: **↻** rebuilds now; **⤓** opens the PDF in your PDF app (to save, print or share).
- **Select text** in the PDF (drag, or double-click a word) to get an action bar:
  - **Source** opens the editor at that passage.
  - **Proofread** proofreads it (see [Proofreading](#proofreading)).
  - **Ask omp…** sends your instruction with the passage's file and lines.
  - **🎙 Dictate** (or `D`) inserts spoken words after it (see [Dictation](#dictation)).
  - **Strike** (`⌫`), **Replace…** (`E`), **Insert…** (`I`, after the selection), **Highlight** (`H`) and
    **Comment…** (`C`) mark it as your tracked change in the source (see [Review](#review)). The PDF
    rebuilds with the mark; ✎ Review lists it for accepting or rejecting. Typed text is escaped unless
    it contains `\` or `$`.

  Ask omp and Fix need `ternlatex dev` running inside Tern. A prompt sent while omp is busy steers the
  running task.
- **Right-click** on the PDF (or Shift+F10, or the menu key) opens ternlatex's menu. On a selection it
  offers the action bar's omp items, **Comment…** and **Insert after…** (Strike, Replace and Highlight stay
  on the bar), plus **Copy text**. Elsewhere it offers **Show source here**, **Ask omp
  about this spot…**, **Insert here…** (your tracked addition after the word you right-clicked),
  **↻ Rebuild**, **± Changes**, **✎ Review**, **Open in PDF app**, **Pop out document** and **Keyboard
  shortcuts**. Hold Shift or ⌥ while right-clicking for the browser's own menu.
- **± Changes** shows a redline (latexdiff) against the last commit or any save checkpoint and keeps it
  current while you edit. **Back to live** returns to the normal PDF.
- **✎ Review (N)** lists tracked changes and comments by file and author. Click one to see it in the PDF
  and the editor, then accept or reject it, or everything from one author.
- **?** (toolbar or key) lists every viewer gesture and key and, inside Tern, the editor keys. Esc
  closes it.

### Tern features and keys

Inside Tern, `ternlatex dev` lays out the tab: editor and viewer side by side, omp below the editor and a
short dev block at the bottom. It reuses blocks a previous `dev` left. Clicks in the viewer open sources
in the editor block, which switches to that file rather than a new block opening each time (a file
already open elsewhere is focused there; an editor with unsaved edits stays, and the file opens in a
block beside it). Prompts go to the project's omp block. If you resize the blocks, ternlatex keeps your
sizes; **Reset layout sizes** in the palette restores the defaults.

Editor keys work in a `.tex` file block of a ternlatex project:

| macOS | Windows, Linux | Command | Does |
|---|---|---|---|
| ⌘⌥J | Ctrl+Alt+J | Show in PDF | scrolls the viewer to the caret's line |
| ⌘⌥O | Ctrl+Alt+O | Outline | opens the outline block |
| ⌘⌥B | Ctrl+Alt+B | Insert citation | searches the `.bib` and Zotero, inserts at the caret |
| ⌘⌥R | Ctrl+Alt+R | Rewrite sentence | offers alternatives for the sentence at the caret |
| ⌘⌥V | Ctrl+Alt+V | Toggle PDF peek | shows the PDF around the caret |

`ternlatex dev` prints these keys at start, and the viewer's **?** lists them. If another Tern action
already holds a key, a toast names it; bind the ternlatex command to another key in Settings ›
Keybindings. A key taken by another app system-wide does nothing; bind another one.

**LaTeX formatting** works in any `.tex` file block, from the palette: **Bold (\textbf)**, **Emphasis
(\emph)**, **Monospace (\texttt)** and **Inline math ($…$)** wrap the selection (or insert the pair with
the caret inside); on text that already has that markup they remove it. **Wrap in environment…** puts
the selected lines (or the caret's line) inside `\begin{…}`…`\end{…}`, adding `\item` for lists; on a
blank line it inserts an empty one. Each edit is one undo step and leaves the file unsaved, like typing.

**Use LaTeX editing keys** (palette) binds ⌘B bold, ⌘I emphasis, ⌘⇧M inline math and ⌘⇧E environment
(Ctrl+Shift+B, I, M, E on Windows and Linux) in your Tern keybindings. Tern itself uses ⌘B and ⌘I
elsewhere: Markdown, Git and SQLite views keep them, and anywhere else ⌘B still toggles the sidebar.
**Remove LaTeX editing keys** puts every key back as it was.

Type `ternlatex` in the palette for every command, including **Review changes**, **Fix build errors with
omp**, **Show PDF viewer** and **Reset layout sizes**.

- **Outline**: a block beside the editor listing the document's sections, figures, tables and labelled
  equations in reading order, numbered from the last build. Below them it lists problems: undefined
  references, unused or duplicate labels, and citations missing from the `.bib`. Use `j`/`k` and Enter,
  or click, to open the source and show it in the PDF. `p` folds the problems; `R` refreshes.
- **Insert citation**: a floating block over the editor. Type to search the project's `.bib` and Zotero.
  ↑/↓ moves, Space marks several entries, Tab switches between `\citep`, `\citet` and the other cite
  commands of your package (natbib, biblatex or plain LaTeX), Enter inserts at the caret, Esc closes.
  Zotero entries are added to the `.bib` first.
- **Rewrite sentence**: alternatives from omp for the sentence at the caret (or the selection), with
  changed words highlighted. Press 1–9, or ↑/↓ and Enter, to replace the sentence (undo works). `r` asks
  again; `/` adds an instruction. Commands, math, citations and references stay unchanged. Unsaved edits
  are saved first.
- **PDF peek**: a floating block showing the PDF around the caret's line, following the caret. It uses
  the last build and needs no dev server. Click it to show the spot in the viewer.
- **Review**: a block listing tracked changes and comments. `a` accepts, `r` rejects, `j`/`k` move, Enter
  opens the source. Open it with **Review changes** in the palette.
- **Open with › Outline / Review**: in a `.tex` file block's ⋯ menu and in the right-click menu of Tern's
  Files list. It opens the outline or review block of the file's project, or focuses the one already
  open. Tern's text editor right-click menu can't be extended; use the keys or the palette there.
- **Status line**: shows the build state of the focused tab's project (⟳ building, ✓ ok, ✗ errors).
  Click it to open the viewer.
- **Error cards**: `ternlatex build` and `ternlatex lint` in a terminal block show diagnostics as cards,
  with **Fix with omp**.
- **Tern's assistant** can build, show source lines in the PDF, list changes and search references.
- When a shell enters a ternlatex project with no `ternlatex dev` running, a toast offers **Start
  ternlatex here**.

The plugin runs with your user's rights, like every Tern plugin. It runs only the ternlatex it installed
with Bun, or the one you ran yourself.

### Proofreading

`ternlatex proofread FILE[:FROM-TO]…` proofreads prose. So do `--doc NAME` and the viewer's **Proofread**
button. Each paragraph goes to omp with no tools and thinking off, four at a time, in about 2–3 seconds
each, using omp's `proofread` role (see [Models](#models)). ternlatex keeps only edits to prose, never to
commands, math, keys, labels or comments, and writes them as tracked suggestions:

```latex
Fast feedback \replaced[id=proof,comment={subject-verb agreement}]{changes}{change} how people write.
```

The PDF shows old and new side by side, with the reason in the margin. The viewer's **✎ Review** lists
each suggestion as `old → new` with its reason. Nothing is applied until you accept a suggestion, or all of
them with `ternlatex accept --author proof`. A checkpoint is taken first, and if a document stops
building the edits are reverted. `--direct` writes the fixes without markup.

### Dictation

Select text in the PDF and click **🎙 Dictate** (or press `D`). Recording starts at once; the system asks
for microphone access the first time. A small pill shows the time, your level and a live transcript.
**Done** (Enter or `D`) finishes; **Cancel** (Esc) discards. Recordings stop after 2 minutes.

Speech is transcribed on your machine with omp's Parakeet model, which punctuates and capitalises. Say
"new paragraph" or "new line" to start one. LaTeX special characters are escaped. The words land after
the selection as a suggestion by the author `dictation`, just like proofreading suggestions. If the
document loads the `changes` package, they appear as `\added[id=dictation]{…}`. Otherwise, and for
paragraph breaks, they wait in **✎ Review** for you to accept them.

Setup, once: run `omp setup speech`. If you set omp's dictation role (in omp's `/model` Roles), it must
be Parakeet (`local/parakeet-tdt-0.6b-v3`); Whisper is not supported. The button's tooltip says what is
missing. Dictation needs no omp block.

### Outline, citations, rewrites and peek from the command line

The Tern features above run these commands. They also work on their own; `--json` prints
machine-readable output.

- `ternlatex outline [--doc NAME]`: the document structure, following `\input`, `\include`, `\subfile`
  and `\import`, then its problems. Comments and verbatim text are ignored.
- `ternlatex refs find [QUERY…] [--limit N]`: `.bib` entries matching every word (key, authors, title,
  year; case and accents ignored; newest first without a query), then Zotero hits not yet in the `.bib`.
  It also names the cite command your package uses: `\citep` (natbib), `\parencite` (biblatex) or
  `\cite`.
- `ternlatex rewrite FILE:LINE:COL [--to LINE:COL] [--count N] [--instruction TEXT]`: alternatives for
  the sentence at that position, or the range up to `--to`, each with a short note. It never writes files.
- `ternlatex peek FILE:LINE [--doc NAME] [--width PX]`: renders the part of the last good PDF around a
  source line to `build/peek/<doc>.png`.
- `ternlatex search QUERY…`: the viewer's search from the command line. Each place has its page,
  `file:line` and the text around it, and is marked "source only" or "pdf only" when it isn't in both.

### Review

Review rounds use the `changes` package, which the house style loads. List the reviewers in
`ternlatex.toml`:

```toml
[review]
authors = [{ id = "AK", name = "Ana K", color = "orange" }]
final = false   # true: typeset as if everything were accepted, without markup
```

Mark edits with `\added[id=AK]{…}`, `\deleted[id=AK]{…}`, `\replaced[id=AK]{new}{old}` and
`\comment[id=AK]{…}`. While authors are listed, omp marks its own prose edits with `id=omp`.

Or mark the PDF itself: select text in the viewer and use the action bar's review tools (Strike,
Replace…, Insert…, Highlight, Comment…). The marks carry your id: `me = "AK"` under `[review]` if set,
else the initials of your git `user.name`. Leave `me` out of a `ternlatex.toml` others share, so each
person's marks carry their own initials.

A comment goes in as `\comment[id=AK]{…}` right after the selected passage, so the passage keeps its line
breaks. A highlight is a wavy underline in your colour, which breaks across lines (the changes package's
default, a coloured box, can't). Selections go through macros: text your own macros typeset
(`\newcommand{\tool}{\textsc{Gallifrey}}`), citations, `\ref`/`\autoref` numbers and math all match, and a
mark that starts or ends in one wraps the whole command (`\deleted[id=AK]{\tool completed}`). A selection that
splits a `{…}` group in the source (half of an `\emph{…}`) is refused with a reason. Comments and strikes
can span paragraphs: a comment goes after the last one, a strike or highlight becomes one per paragraph
(`changes` commands can't hold a paragraph break); a replacement covers one paragraph. Without the `changes`
package, strikes, replacements and insertions wait in ✎ Review as suggestions; highlights and comments
need it.

`ternlatex comments import annotated.pdf --author AK` turns a reviewer's PDF annotations (sticky notes,
highlights) into `\comment`s on the matching source lines. `/skill:review` has omp work through the
comments. `ternlatex changes`, `accept` and `reject` do the same on the command line.

### History

Every save is checkpointed, whether you or omp made the edit. A checkpoint snapshots the working tree to
a separate git ref in about 20 ms; HEAD, your branch, the index and the stash are untouched. omp commits
only when you ask.

- `ternlatex checkpoints` lists checkpoints, newest first.
- `ternlatex diff [REV]` builds a redline PDF of the working tree against a checkpoint or revision
  (default HEAD).
- `ternlatex restore REV [PATH…]` brings files back, checkpointing the current state first.

Set `checkpoints = false` in `ternlatex.toml` to turn checkpoints off.

### Several documents

A project can hold several documents, such as a paper, supplement, slides and cover letter. Each builds to
its own `build/<name>.pdf`:

```toml
[[documents]]
name = "paper"
root = "main.tex"

[[documents]]
name = "slides"
root = "slides.tex"
```

A save rebuilds only the documents that read the changed file, the one on screen first. ternlatex keeps
the last 8 builds of each document. When the sources match one of them (a save that changes nothing, an
undone edit, a `dev` restart), the viewer shows that PDF at once ("Reused earlier build"). **↻** in the
viewer and `ternlatex build --force` always compile.

The viewer shows a strip with each document's live status. Switch with ⌥1…⌥9 or ⌥[ and ⌥]; `#doc=NAME`
in the URL opens a document. Position and zoom are remembered per document. **⧉** on a document opens it
in a second viewer block beside the first, e.g. the paper next to the slides. `ternlatex docs` lists the
documents; `build`, `snapshot`, `show`, `diff`, `outline`, `peek`, `fix`, `proofread` and
`comments import` take `--doc NAME`.

### Zotero

Citations come from your Zotero library.

- `source = "local"` (the default) talks to the Zotero desktop app. Start Zotero 7 or later and enable
  Settings › Advanced › "Allow other applications on this computer to communicate with Zotero". With
  Better BibTeX installed, its citation keys and exports are used.
- `source = "web"` uses api.zotero.org with `library = "group:<id>"` or `"user:<id>"`. Public libraries
  need no key. For a private library, create a read-only key at
  <https://www.zotero.org/settings/keys/new> and set `ZOTERO_API_KEY`.

Citation keys come from the item's Citation Key field, else a `Citation Key:` line in Extra, else
Zotero's generated BibTeX key.

Cite a key and save: undefined citations are fetched, appended to the `bib` file (default `refs.bib`,
under `% Imported from Zotero by ternlatex`) and the PDF rebuilds. Existing entries are never rewritten.
Or ask omp: `/skill:cite the 2020 Smith paper on X here`. `ternlatex refs sync`, `refs search QUERY` and
`refs add KEY…` do the same by hand.

### omp skills and tools

The omp block ternlatex opens loads ternlatex's omp extension (`omp -e`), so nothing is written into your
project for omp. It gives omp the project rules, eight skills, and four tools: `latex_build` (build and
read the diagnostics), `latex_snapshot` (look at a rendered page), `latex_show` (scroll your viewer to a
line) and `latex_search` (the viewer's search, so "the sentence about X on page 3" leads omp to the right
`file:line`). Projects set up by ternlatex 0.1 had these rules and skills as files in
`.omp/`; the omp block removes those copies the first time it starts.

| Skill | Does |
|---|---|
| `/skill:table data.csv …` | builds a booktabs + siunitx table in `tables/`, inserts and references it, checks it visually |
| `/skill:proofread sections/intro.tex` | runs `ternlatex proofread`, then on request checks consistency and LaTeX hygiene |
| `/skill:style …` | changes fonts, colours, headings, margins or captions, in `style/ternlatex.sty` only |
| `/skill:fix-build` | fixes the last build's errors, first error first |
| `/skill:import-cleanup` | turns pandoc output into idiomatic LaTeX |
| `/skill:find-template NeurIPS 2026` | switches the project to a venue, publisher or thesis template, adapts it for Tectonic and builds |
| `/skill:cite the Smith 2020 paper on X here` | finds the item in Zotero, inserts `\citet`/`\citep` with its key, imports the entry, builds |
| `/skill:review` | works through reviewers' `\comment`s, summarises open changes per author, makes tracked edits as omp |

## Commands

Run commands anywhere inside a project (a folder with `ternlatex.toml`), or pass its `DIR`.
`ternlatex --help` shows every option.

| Command | Does |
|---|---|
| `init [DIR] [--template article\|report\|letter\|beamer] [--force]` | creates a project from a template |
| `import SRC [DIR]` | adopts a `.tex` project in place, or converts `.docx` `.odt` `.md` `.html` `.rtf` `.epub` with pandoc |
| `setup-tern` | connects Tern to this ternlatex and reloads Tern's plugins (`dev` does this by itself) |
| `install-cli [DIR]` | puts a `ternlatex` command for this ternlatex into `DIR` (default: Bun's bin folder) |
| `uninstall [--keep-cache] [--yes]` | removes ternlatex outside your projects: the Tern plugin, launchers, a global Bun install, the cache and the data folder |
| `dev [DIR] [--port N] [--no-tern] [--open]` | watches, rebuilds on save and serves the viewer; lays out Tern blocks |
| `stop [DIR]` / `restart [DIR]` | stops or restarts the running dev server |
| `docs` | lists the project's documents and their last build |
| `models` | shows which model each task uses (omp roles `latex`, `proofread`, `rewrite`) |
| `pull [--json]` | in a clone of an Overleaf project, rebases onto Overleaf's latest; never pushes |
| `build [DIR] [--doc NAME] [--all] [--force]` | builds through the running dev server if any; prints `file:line: severity: message`, exits 1 on errors; `--all` adds info messages |
| `snapshot (--page N \| FILE:LINE) [--doc NAME] [--dpi N] [--out PNG]` | renders one PDF page to PNG (default `build/snapshots/<doc>-page-N.png`) |
| `show FILE:LINE [--doc NAME]` | scrolls the viewer to a source line and highlights it |
| `outline [--doc NAME] [--json]` | document structure and reference problems |
| `peek FILE:LINE [--doc NAME] [--width PX] [--json]` | renders the PDF around a source line to `build/peek/<doc>.png` |
| `search QUERY… [--doc NAME] [--json]` | fuzzy search of the PDF text and the LaTeX prose: page, `file:line` and context per place |
| `fix [--doc NAME]` | sends the last build's errors and warnings to omp (needs a running `dev`) |
| `proofread [FILE[:FROM-TO]…] [--doc NAME] [--direct]` | proofreads prose into tracked `proof` suggestions |
| `rewrite FILE:LINE:COL [--to LINE:COL] [--count N] [--instruction TEXT] [--json]` | prints alternative wordings; never writes files |
| `lint [FILE…]` | runs chktex (default: every `.tex` file in the project) |
| `agent [DIR]` | starts omp in the project, continuing its latest session |
| `bundle FILE…` | tells whether a class, package or `.bst` is in the TeX Live bundle, and its version |
| `tool NAME [ARGS…]` / `tool --path NAME` | runs, or prints the path of, a tool ternlatex uses |
| `checkpoints [--limit N]` | lists save checkpoints |
| `restore REV [PATH…]` | restores files from a checkpoint or git revision |
| `diff [REV] [--doc NAME] [--open]` | builds a redline PDF of REV (default HEAD) against the working tree |
| `refs sync` / `search QUERY… [--limit N]` / `add KEY…` / `find [QUERY…] [--limit N] [--json]` | imports cited keys from Zotero, searches Zotero, adds entries, searches `.bib` then Zotero |
| `changes [--author ID] [--json]` | lists open tracked changes and comments |
| `accept` / `reject (ID…\|--author ID\|--all)` | accepts or rejects tracked changes; comments are removed either way |
| `comments import FILE.pdf --author ID [--doc NAME]` | turns PDF annotations into `\comment`s, then builds |
| `doctor [--warm]` | checks the toolchain; `--warm` downloads the tools and the templates' TeX packages |

## Configuration

### `ternlatex.toml`

At the project root. Every key is optional. Uncommented values below are the defaults; commented ones
are examples.

```toml
root = "main.tex"        # or [[documents]] tables, see "Several documents"
outdir = "build"
engine = "tectonic"      # or "latexmk": uses your own TeX installation, for shell-escape or biber
latexmk_args = ["-xelatex"]   # used with engine = "latexmk"
bundle = "https://data1b.fullyjustified.net/tlextras-2022.0r0.tar"
# port = 4820            # default: a fixed port per project
# ignore = ["data/raw"]  # paths the watcher ignores
checkpoints = true      # checkpoint every save (see "History")
partial = true          # on a failed build, show a PDF built past the errors (missing files as placeholders)

[tools]                  # executables to use instead of PATH or the download
# tectonic = "/opt/tectonic/bin/tectonic"

[zotero]
source = "local"         # or "web"
library = "user"         # web: "user:<id>" or "group:<id>"
# collection = "ABCD1234" # search only this collection (its key)
bib = "refs.bib"
auto_import = true       # fetch undefined \cite keys from Zotero after a build

[review]
authors = []
final = false

[proofread]
parallel = 4             # paragraphs at a time (up to 16)

[rewrite]
count = 4                # alternatives per request (1–9)
```

### Models

ternlatex has no model settings of its own: each task uses an omp role, so you choose models where your
providers already are, and a project shared through git names no provider. A role you haven't defined
falls back to the next one:

| Task | omp roles, first defined wins |
|---|---|
| the omp block (writing assistant) | `latex`, else omp's default model |
| proofreading | `proofread`, else `smol` |
| rewrite alternatives (editor and PDF) | `rewrite`, else `proofread`, else `smol` |

Define them under `modelRoles` in omp's `config.yml` (`omp config path` prints its folder):

```yaml
modelRoles:
  latex: anthropic/claude-opus-4-5
  proofread: openai/gpt-5-mini
```

`ternlatex models` shows what each task uses now. Proofreading and rewrites pick a change up within 30
seconds; reopen the omp block for its model. A project's own `.omp/config.yml` roles count for its omp
block only. Older projects' `ternlatex.toml` may still have `model = …` under `[proofread]`; it is no
longer read.

### Environment variables

| Variable | Effect |
|---|---|
| `TERNLATEX_<NAME>` | path of a tool, e.g. `TERNLATEX_TECTONIC`, `TERNLATEX_OMP` |
| `TERNLATEX_CACHE` | where downloaded tools and TeX packages go |
| `ZOTERO_API_KEY` | Zotero web API key, for private libraries |

The cache defaults to `~/Library/Caches/ternlatex` on macOS, `$XDG_CACHE_HOME/ternlatex` or
`~/.cache/ternlatex` on Linux, and `%LOCALAPPDATA%\ternlatex` on Windows.

### Where tools come from

The tools are `tectonic`, `pandoc`, `latexdiff`, `perl`, `git`, `chktex`, `latexmk`, `omp` and `tern`.
For each, ternlatex uses the first it finds of: `TERNLATEX_<NAME>`, the project's `[tools]` table, your
`PATH`, and, for tectonic, pandoc and latexdiff, its pinned download. `ternlatex doctor` shows where each
tool came from.

## Tectonic limits

- No shell-escape: `minted` and `\write18` don't work. Use `listings`, or `engine = "latexmk"`.
- No biber: use natbib with bibtex, or `\usepackage[backend=bibtex]{biblatex}`.
- System fonts work but tie the build to your machine. Prefer bundle fonts (Libertinus, TeX Gyre, Latin
  Modern, Fira) or fonts committed under `fonts/` (`fontspec` with `Path=fonts/`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) to build, test and release ternlatex.

## License

MIT; see [LICENSE](LICENSE).
