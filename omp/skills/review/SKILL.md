---
name: review
description: Work with tracked changes and review comments from the LaTeX changes package (\added, \deleted, \replaced, \comment, \highlight with id=AUTHOR) — address reviewers' comments, summarise open changes per author, make tracked edits as omp, accept or reject changes, import PDF annotations, toggle final.
---

# Review with the `changes` package

The house style (`style/ternlatex.sty`) loads `changes` and the generated `style/ternlatex-review.tex`, which declares the authors from `[review]` in `ternlatex.toml` plus `omp` (name "omp", its own colour). ternlatex rewrites that file before every build; never edit it.

```latex
\added[id=AK]{new text}
\deleted[id=AK]{old text}
\replaced[id=AK]{new text}{old text}        % new first, then old
\comment[id=AK]{a note in the margin}
\highlight[id=AK]{marked text}
\added[id=AK, comment={why}]{new text}       % comment= works on added/deleted/replaced/highlight
```

An `id` not in `[review] authors` (or `omp`) stops the build with "Undefined changes author". Fix it by adding the author to the toml, e.g. `authors = [{ id = "AK", name = "Ana K", color = "orange" }]`; never by deleting the id.

## Commands

- `ternlatex changes [--author ID]`: one line per open change, `id  kind  author  file:line  text`. An id stays valid until that change's text is edited or another change in the same file is resolved; list again after resolving.
- `ternlatex accept ID…` / `ternlatex reject ID…`; `--author ID` or `--all` instead of ids. Accept keeps new text and drops deleted text; reject does the opposite. Both remove `\comment`s and keep `\highlight`ed text without its markup. The file rewrite triggers a rebuild.
- `ternlatex comments import FILE.pdf --author ID [--doc NAME]`: turns the PDF's sticky notes, free-text notes and highlight/underline/strike-out annotations into `\comment[id=ID]{…}` at the end of the source line they sit on (highlights quote the marked text). The PDF must come from the current build. If an inserted comment breaks the build (math, tabular, captions), it is moved to the end of the paragraph or dropped, and the command says so.

## Address comments

When asked to address review comments (all of them, or one author's):

1. `ternlatex changes --author ID`, keep the `comment` lines.
2. For each comment, read the surrounding text and make the change it asks for. Mark your prose edits as tracked changes (below), unless the user asked for direct edits.
3. When a comment is dealt with, resolve it: `ternlatex accept COMMENT_ID` (removes the comment; accept and reject do the same for comments). If you disagree, or the comment needs the author's judgement, leave it open and add your reply next to it as `\comment[id=omp]{…}`.
4. `latex_build`; report per comment: `file:line: comment → what you did` (or why it stays open).

## Summarise

When asked what is open: run `ternlatex changes` and report per author the counts by kind (added, deleted, replaced, comment, highlight) and the files they are in, then the open comments in full. Do not resolve anything while summarising.

## Tracked edits as omp

When the user asks you to edit with tracking, or `ternlatex.toml` lists `[review]` authors (a review round is on) and they did not ask for direct edits, wrap every prose edit:

- inserted text: `\added[id=omp]{…}`
- removed text: `\deleted[id=omp]{…}`
- rewritten text: `\replaced[id=omp]{new}{old}`, scoped to the smallest span that changed (a word or phrase, not the whole sentence).

Keep markup out of places where it breaks or makes no sense: math, `\label`/`\ref`/`\cite` keys, `tabular` alignment (`&`, `\\`), verbatim and section titles (track inside the title text only if it stays one argument). Edit those directly and mention them. Never wrap someone else's change in yours; edit inside it, or ask.

## Never

- Accept or reject other authors' changes (or `--all`) unless the user asks you to. Resolving a comment you have addressed is fine.
- Change an author's id, name or colour in `ternlatex.toml` without being asked.

## Final versus draft

`final = true` under `[review]` typesets as if every change were accepted: no colours, no comments, deleted text gone. Markup stays in the source. Use it to preview or submit the clean version; set it back to `false` to see the markup again. It takes effect on the next build.

## Projects without the house style

Venue templates that do not load `style/ternlatex` need these two preamble lines:

```latex
\InputIfFileExists{style/ternlatex-review.tex}{}{}
\usepackage{changes}\csname tlreviewsetup\endcsname
```

Without the generated file the second line still works (no authors defined, draft markup).
