---
name: proofread
description: Proofread LaTeX prose (a file, section, line range or selection) with `ternlatex proofread`, which sends each paragraph to a no-reasoning model and writes the fixes as tracked suggestions for the user to accept; then cover what a per-paragraph pass cannot (consistency, LaTeX hygiene, judgement calls).
---

# Proofread

Arguments: the scope, e.g. `sections/intro.tex`, `sections/intro.tex:10-40`, "the Methods section", or a selection. Default: the file the user is editing; ask if unclear. Never proofread outside the scope.

## 1. Mechanical pass (do not do this yourself)

Run `ternlatex proofread <FILE[:FROM-TO]>...` (or `--doc NAME` for a whole document).
It sends each prose paragraph to omp with tools and thinking off, keeps only edits that change prose
(never commands, math, keys, labels or comments), and writes them as
`\replaced[id=proof,comment={reason}]{new}{old}` tracked changes. The user accepts or rejects them in the
viewer's ✎ Review panel, or with `ternlatex accept|reject --author proof`.

- Do not re-check or redo those corrections, and never accept or reject them for the user.
- If it reports `reverted` (the build broke), tell the user and stop.
- If the document does not load the `changes` package, tell the user; use `--direct` only if they ask
  for direct edits.

## 2. What the mechanical pass cannot see

Only when the user asks for a thorough proofread, look across the scope for:

1. Consistency: terminology, hyphenation (`data set` vs `dataset`), capitalisation of headings,
   abbreviations defined once before use, British vs American spelling (keep the majority; never convert).
2. LaTeX hygiene: `~` before `\ref`/`\cite` (not before `\cref`/`\citet`), `--` for ranges, `---` or the
   project's dash style, ``` ``quotes'' ``` or `\enquote`, `\ldots`, `e.g.\ `, siunitx for numbers and units.
   Include `ternlatex lint <files>` findings.

Make these edits as tracked changes with `id=omp` when a review round is on (see AGENTS.md), otherwise
minimal direct edits. Never change math, keys, labels, paths, numbers or technical claims; never reflow lines.

## 3. Report

`ternlatex proofread`'s summary (N suggestions waiting in Review), then your own changes grouped by
category (`file:line: old -> new`), then a "Needs your judgement" list: possible factual errors,
rewrites that could shift meaning, style choices with no clear project convention.
