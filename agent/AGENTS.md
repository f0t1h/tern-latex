# ternlatex project

This is a LaTeX project edited live in Tern.
The user watches the PDFs in a viewer block; `ternlatex dev` rebuilds on every save.
`ternlatex.toml` at the project root lists the documents (`root = "main.tex"` for one, or `[[documents]]` tables with `name` and `root` for several, e.g. paper, supplement, slides), plus `engine` and `outdir`.
Run `ternlatex docs` to see them. Each document builds to `build/<name>.pdf`; a save rebuilds only the documents that read the changed file, and sources identical to one of the last 8 builds reuse its PDF (`ternlatex build --force` compiles anyway).

## Toolchain

- Engine: Tectonic 0.17 (XeTeX). Packages come from a pinned TeX Live 2022 bundle.
- No shell-escape: `minted` and `\write18` are unavailable. Use `listings` for code.
- Bibliographies: bibtex + natbib, run automatically by Tectonic. biber/biblatex-biber is unavailable.
- Fonts: prefer bundle fonts (Libertinus, TeX Gyre, Latin Modern, Fira) via `fontspec`, or project-local fonts in `fonts/` loaded with `fontspec` `Path=fonts/`. System fonts work but are not reproducible.

## Commands

- `ternlatex build [--doc NAME]`: build every document, or one (through the dev server if running). Prints `file:line: severity: message`; exit 1 on errors.
- `ternlatex snapshot --page N [--doc NAME]` or `ternlatex snapshot FILE:LINE`: render a page to PNG and print its path. Read the PNG to check the result. FILE:LINE finds the document containing that line.
- `ternlatex show FILE:LINE [--doc NAME]`: scroll the user's viewer to that spot (switching document if needed) and highlight it.
- `ternlatex lint [FILE...]`: chktex diagnostics.
- `ternlatex tool NAME ARGS...` (tectonic, pandoc, latexdiff, git, …): run a tool exactly as ternlatex resolves it. Never call tools by path or assume where they are installed.
- `ternlatex proofread FILE[:FROM-TO]... [--doc NAME]`: mechanical proofreading by a no-reasoning model, one call per paragraph; fixes land as `\replaced[id=proof]{…}{…}` suggestions for the user to accept. Use it instead of proofreading prose yourself.
- `ternlatex checkpoints`, `ternlatex diff [REV] [--doc NAME]`, `ternlatex restore REV [PATH...]`: every save is snapshotted on `refs/ternlatex/checkpoints`; `diff` builds a redline PDF against a commit or checkpoint; `restore` brings files back (checkpointing the current state first).
- `ternlatex refs search QUERY...`: search the user's Zotero library; one line per item: `key<TAB>year<TAB>creators<TAB>title`. `ternlatex refs find QUERY...` searches the project's .bib first, then Zotero (adds a `bib`/`zotero` column).
- `ternlatex outline [--doc NAME] [--json]`: the document's sections, floats and labelled equations with their numbers, then problems (undefined refs, unused/duplicate labels, missing citations) as `file:line: kind: key`.
- `ternlatex refs add KEY...` / `ternlatex refs sync`: append Zotero entries for those keys / for every cited key no .bib defines (never touches existing entries). Undefined citations are also imported automatically after each build.
- `ternlatex changes [--author ID]`, `ternlatex accept|reject (ID...|--author ID|--all)`, `ternlatex comments import FILE.pdf --author ID`: tracked changes and comments (`changes` package).
- `build/status.json`: `{docs: [{doc, root, build, rev, state, ok, diagnostics:[{severity,file,line,message}]}]}`.

## Working loop

1. Edit the source.
2. Run `ternlatex build`.
3. Read the diagnostics. Fix every error you caused, then warnings you caused.
4. Run `ternlatex snapshot` on the affected page and look at the PNG.
5. Run `ternlatex show FILE:LINE` when the user should look at the change.

Never leave the build broken. If you cannot fix an error, revert your change and tell the user.

## Rules

- Never edit `build/`. The project is a git repo; keep every change reviewable.
- Never commit unless the user asks. Saves are checkpointed automatically; when asked to commit, write a concise message and add `Co-authored-by: omp <omp@localhost>`.
- Keep diffs minimal. Preserve line structure. Keep one sentence per line where the project already does so.
- Styling lives in `style/ternlatex.sty` (in imported projects: the existing preamble or style file). Do not put fonts, colours or layout in body files.
- When the project uses a publisher or venue class (IEEEtran, acmart, llncs, elsarticle, revtex, a NeurIPS/ICML/ICLR/ACL style, a university thesis class), the class owns the layout: do not restyle it, do not load `style/ternlatex.sty` on top of it, and keep the options the venue requires.
- Use semantic macros over hard-coded spacing: no `\vspace`, `\\[..]`, `\hspace` or manual font switches to fix layout.
- Tables go in `tables/<name>.tex`, figures in `figures/`; `\input` them where they appear.
- Cross-reference with `\cref`/`\Cref` (cleveref). Typeset numbers and units with siunitx (`\num`, `\SI`, `S` columns). Rule tables with booktabs; never use vertical rules or `\hline`.
- During prose edits never alter math meaning, citation keys, `\label` names or `\ref`/`\cref` targets.
- Treat overfull/underfull box warnings as formatting work: fix them at the source (rewording, `tabularx`, line breaks in tables), not by hiding them.
- Cite only keys from `ternlatex refs search` or the existing .bib; never invent keys or hand-write entries for works in Zotero.
- When `ternlatex.toml` lists `[review]` authors (a review round is on), mark your prose edits as tracked changes with `id=omp`: `\added[id=omp]{…}`, `\deleted[id=omp]{…}`, `\replaced[id=omp]{new}{old}`, each scoped to the smallest changed span. Edit directly (unmarked) when the user asks, and always inside math, labels/refs/cite keys and tabular alignment. Never accept or reject other authors' changes unless asked; see the `review` skill.

## Skills

`/skill:table`, `/skill:proofread`, `/skill:style`, `/skill:fix-build`, `/skill:import-cleanup`, `/skill:find-template`, `/skill:cite`, `/skill:review`.
