# ternlatex project

This is a LaTeX project edited live in Tern.
The user watches the PDFs in a viewer block; `ternlatex dev` rebuilds on every save.
`ternlatex.toml` at the project root lists the documents (`root = "main.tex"` for one, or `[[documents]]` tables with `name` and `root` for several, e.g. paper, supplement, slides), plus `engine` and `outdir`.
Run `ternlatex docs` to see them. Each document builds to `build/<name>.pdf`; a save rebuilds only the documents that read the changed file, and sources identical to one of the last 8 builds reuse its PDF (`latex_build` with `force` compiles anyway).

## Toolchain

- Engine: Tectonic 0.17 (XeTeX). Packages come from a pinned TeX Live 2022 bundle.
- No shell-escape: `minted` and `\write18` are unavailable. Use `listings` for code.
- Bibliographies: bibtex + natbib, run automatically by Tectonic. biber/biblatex-biber is unavailable.
- Fonts: prefer bundle fonts (Libertinus, TeX Gyre, Latin Modern, Fira) via `fontspec`, or project-local fonts in `fonts/` loaded with `fontspec` `Path=fonts/`. System fonts work but are not reproducible.

## Tools

- `latex_build` (`doc`, `force` optional): build every document, or one, through the dev server if running. Returns `file:line: severity: message` lines.
- `latex_snapshot` (`page` or `at` = FILE:LINE, `doc` optional): render a page of the built PDF and return it as an image. `at` renders the page that line lands on.
- `latex_show` (`at` = FILE:LINE, `doc` optional): scroll the user's viewer to that spot (switching document if needed) and highlight it.
- `latex_search` (`query`, `doc` optional): where words are in the built PDF and the LaTeX prose, typos and markup tolerated: `p.N  file:line  …context[match]context…` per place. Use it first when the user quotes or describes text from the PDF ("the sentence on page 3 about …"), or to find prose spread over `\input` files; grep is still right for macros, labels and code.

## Commands

Everything else runs through the `ternlatex` CLI:

- `ternlatex lint [FILE...]`: chktex diagnostics.
- `ternlatex tool NAME ARGS...` (tectonic, pandoc, latexdiff, git, …): run a tool exactly as ternlatex resolves it. Never call tools by path or assume where they are installed.
- `ternlatex proofread FILE[:FROM-TO]... [--doc NAME]`: mechanical proofreading by a no-reasoning model, one call per paragraph; fixes land as `\replaced[id=proof]{…}{…}` suggestions for the user to accept. Use it instead of proofreading prose yourself.
- `ternlatex checkpoints`, `ternlatex diff [REV] [--doc NAME]`, `ternlatex restore REV [PATH...]`: every save is snapshotted on `refs/ternlatex/checkpoints`; `diff` builds a redline PDF against a commit or checkpoint; `restore` brings files back (checkpointing the current state first).
- `ternlatex refs search QUERY...`: search the user's Zotero library; one line per item: `key<TAB>year<TAB>creators<TAB>title`. `ternlatex refs find QUERY...` searches the project's .bib first, then Zotero (adds a `bib`/`zotero` column).
- `ternlatex outline [--doc NAME] [--json]`: the document's sections, floats and labelled equations with their numbers, then problems (undefined refs, unused/duplicate labels, missing citations) as `file:line: kind: key`.
- `ternlatex refs add KEY...` / `ternlatex refs sync`: append Zotero entries for those keys / for every cited key no .bib defines (never touches existing entries). Undefined citations are also imported automatically after each build.
- `ternlatex changes [--author ID]`, `ternlatex accept|reject (ID...|--author ID|--all)`, `ternlatex comments import FILE.pdf --author ID`: tracked changes and comments (`changes` package).
- `build/status.json`: `{docs: [{doc, root, build, rev, state, ok, partial, placeholders, diagnostics:[{severity,file,line,message}]}]}`.

## Working loop

1. Edit the source.
2. Call `latex_build`.
3. Read the diagnostics. Fix every error you caused, then warnings you caused.
4. Call `latex_snapshot` on the affected page and look at the image.
5. Call `latex_show` when the user should look at the change.

Never leave the build broken. If you cannot fix an error, revert your change and tell the user.

A failed build still shows a PDF when it can: `latex_build` then says PARTIAL, the PDF is built past the errors, and missing figures or `\input` files (often not yet pushed by a co-author on Overleaf) are drawn as placeholder boxes. That build is still broken: fix what you caused; for files that are missing, tell the user rather than creating stand-ins.

## Rules

- Never edit `build/`. The project is a git repo; keep every change reviewable.
- Never commit unless the user asks. Saves are checkpointed automatically; when asked to commit, write a concise message and add `Co-authored-by: omp <omp@localhost>`.
- In a clone of an Overleaf project (its git remote is git.overleaf.com, or an Overleaf server's `/git/` URL), co-authors edit in the browser too. ternlatex rebases the clone onto Overleaf's latest before your first edit of each request: when that brings changes, your edit is refused once with the files that changed; read them again, then redo the edit. When it reports that Overleaf could not be pulled, tell the user before editing. Never push unless the user asks; `ternlatex pull` brings the clone up to date by hand.
- Keep diffs minimal. Preserve line structure. Keep one sentence per line where the project already does so.
- Styling lives in `style/ternlatex.sty` (in imported projects: the existing preamble or style file). Do not put fonts, colours or layout in body files.
- When the project uses a publisher or venue class (IEEEtran, acmart, llncs, elsarticle, revtex, a NeurIPS/ICML/ICLR/ACL style, a university thesis class), the class owns the layout: do not restyle it, do not load `style/ternlatex.sty` on top of it, and keep the options the venue requires.
- Use semantic macros over hard-coded spacing: no `\vspace`, `\\[..]`, `\hspace` or manual font switches to fix layout.
- Tables go in `tables/<name>.tex`, figures in `figures/`; `\input` them where they appear.
- Cross-reference in the style the project already uses: `\cref`/`\Cref` where it loads cleveref (new ternlatex projects do), else what its sources use (`\autoref`, `Table~\ref{…}`). Never add a `\cref` to a project that doesn't load cleveref, and don't convert existing references to another style unless asked. Typeset numbers and units with siunitx (`\num`, `\SI`, `S` columns). Rule tables with booktabs; never use vertical rules or `\hline`.
- During prose edits never alter math meaning, citation keys, `\label` names or `\ref`/`\cref` targets.
- Treat overfull/underfull box warnings as formatting work: fix them at the source (rewording, `tabularx`, line breaks in tables), not by hiding them.
- Cite only keys from `ternlatex refs search` or the existing .bib; never invent keys or hand-write entries for works in Zotero.
- When `ternlatex.toml` lists `[review]` authors (a review round is on), mark your prose edits as tracked changes with `id=omp`: `\added[id=omp]{…}`, `\deleted[id=omp]{…}`, `\replaced[id=omp]{new}{old}`, each scoped to the smallest changed span. Edit directly (unmarked) when the user asks, and always inside math, labels/refs/cite keys and tabular alignment. Never accept or reject other authors' changes unless asked; see the `review` skill.

## Skills

`/skill:table`, `/skill:proofread`, `/skill:style`, `/skill:fix-build`, `/skill:import-cleanup`, `/skill:find-template`, `/skill:cite`, `/skill:review`.
