---
name: import-cleanup
description: Clean up a LaTeX document produced by pandoc (from Word, Markdown or HTML) into idiomatic project LaTeX, removing pandoc boilerplate, rebuilding tables, figures, headings, quotes and dashes, and moving preamble cruft into the style file.
---

# Import cleanup

Use after `pandoc` converted a document into this project. Work in logical steps; after each step call `latex_build` and fix anything you broke before moving on, so each step is a reviewable diff.

## 1. Preamble

- Remove pandoc boilerplate: `\providecommand{\tightlist}{...}`, `\pandocbounded` definitions, `\def\LT@makecaption...` and other `\def\LT@...` patches, `\makeatletter` blocks that only serve those, `\setlength{\emergencystretch}`, `\setcounter{secnumdepth}{-\maxdimen}` (unless the author wants unnumbered headings), `\usepackage{lmodern}`, `iftex`/`ifxetex` branches, `\urlstyle{same}`, `bookmark`, and hypersetup clutter (`pdfcreator`, empty `pdftitle`, `hidelinks` duplicates).
- Move remaining styling (fonts, colours, geometry, caption setup) into `style/ternlatex.sty` and load it with `\usepackage{style/ternlatex}`. Drop packages the style already loads.
- Keep `\title`, `\author`, `\date` in `main.tex`.

## 2. Body boilerplate

- Delete every `\tightlist`.
- Replace `\pandocbounded{\includegraphics[keepaspectratio]{x}}` with a plain `\includegraphics[width=\linewidth]{figures/x}`.
- Remove `\hypertarget{id}{%` wrappers and their closing `}` and leftover `\label`s pandoc generated from heading text, replacing them with meaningful `\label{sec:...}` names. Update every `\ref`/`\hyperref` that pointed at them.

## 3. Headings

Pandoc may use the wrong level or `\section*` everywhere. Map them to the intended hierarchy, remove manual numbering in heading text ("2.1 Method"), and add `\label{sec:<name>}` where the text refers to sections.

## 4. Tables

- Single-page longtables become `table` floats with `tabular`, booktabs rules, siunitx `S` columns for numbers, caption above, `\label{tab:<name>}`. Move each into `tables/<name>.tex` and `\input` it. See `/skill:table`.
- Keep `longtable` where the table really spans pages; still clean it to booktabs with proper `\endfirsthead`/`\endhead`.
- Replace `\real{0.25}` / `\linewidth - 6\tabcolsep` column arithmetic with `tabularx` `X` columns.

## 5. Figures

Bare `\includegraphics` lines become `figure` floats with `\centering`, a `\caption` (from the alt text or adjacent caption paragraph) and `\label{fig:<name>}`. Move images into `figures/`.

## 6. Typography

- Quotes: straight or Unicode quotes to ``` ``..'' ``` / `` `..' `` (or `\enquote` if csquotes is loaded), consistently.
- Dashes: ranges `--`, em dashes `---` (or the document's spaced en-dash convention); minus signs in math.
- Manual references ("see Table 3", "Figure 2 below") become `\label`/reference pairs in the project's style: `\cref{...}` when it loads cleveref, else `\autoref{...}` with hyperref, else `Table~\ref{...}`.
- Numbers with units become `\SI{..}{..}`.
- Remove manual spacing (`\\` paragraph breaks, `\vspace`, `\newline` runs) that came from Word layout.

## 7. Citations

If pandoc produced citeproc output (a literal reference list), keep it and tell the user; converting to a `.bib` needs the source data. If it produced `\cite` commands, ensure natbib keys exist in `refs.bib`.

## Done

Build is clean (no errors, no overfull boxes), `latex_snapshot` of a few representative pages looks right, and you report a short list of steps performed plus anything left for the author.
