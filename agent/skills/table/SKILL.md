---
name: table
description: Create or rework a LaTeX table from CSV/TSV, markdown, pasted text or a description; writes tables/<name>.tex with booktabs, siunitx S columns, caption and label, and inputs it into the document.
---

# Table

Arguments: the data (file path, pasted text or description), an optional table name, and where it goes (file:line, section, "after the paragraph about X").

## Input

- CSV/TSV file: read it; detect the delimiter, header row and quoting.
- Markdown or pasted text: parse rows and columns; ask only if the column split is ambiguous.
- Description only: build the structure and leave clearly marked placeholder cells (`\tlnote{TBD}`) for unknown values.
- XLSX/ODS: ask the user to export to CSV first; do not try to read spreadsheets.

## Output: `tables/<name>.tex`

`<name>` is short kebab-case (`results`, `ablation-lr`). Never overwrite an existing table file unless asked.

```latex
\begin{table}[htbp]
  \centering
  \caption{One-sentence description of what the table shows.}
  \label{tab:<name>}
  \begin{tabular}{l S[table-format=3.1] S[table-format=1.2]}
    \toprule
    {Model} & {Time (\si{\second})} & {Accuracy} \\
    \midrule
    Baseline & 12.5 & 0.81 \\
    Ours     &  9.3 & 0.87 \\
    \bottomrule
  \end{tabular}
\end{table}
```

Rules:

- booktabs only: `\toprule`, `\midrule`, `\cmidrule(lr){a-b}`, `\bottomrule`. No vertical rules, no `\hline`, no cell colours unless asked.
- Numeric columns are siunitx `S` columns. Set `table-format` from the data: integer digits `.` decimals, plus sign/exponent room, e.g. `-2.3`, `4.0`, `1.2e3`, `2.1(3)` for uncertainties. Keep the source's precision; do not round silently.
- Wrap non-numeric cells in `S` columns (headers, `--`, footnote marks) in braces: `{n/a}`.
- Units go in the header (`{Mass (\si{\kilo\gram})}`), not in every cell.
- Text columns: `l`; long text columns: `X` (tabularx) or `p{..}`.
- Caption above the table, `\label{tab:<name>}` right after the caption.
- Mark best values only if asked: write `\bfseries 0.87` in the cell and add `detect-weight, mode=text` to that column's `S[...]` options.

## Width

- Fits within `\linewidth`: plain `tabular`.
- Too wide because of text columns: `\begin{tabularx}{\linewidth}{l X S ...}`.
- Too wide because of many numeric columns: first shorten headers (two-line headers with `\makecell`, which needs `\RequirePackage{makecell}` in the style file, or abbreviations explained in the caption), reduce `table-format`, set `\setlength{\tabcolsep}{4pt}` inside the float. Only as a last resort wrap the `tabular` in `\resizebox{\linewidth}{!}{...}`, and never when that shrinks text below about 80%.
- Very wide: `sidewaystable` (add `\RequirePackage{rotating}` to the style file) on its own page.

## Length

- More rows than fit on a page: use `longtable` (add `\RequirePackage{longtable}` to the style file before hyperref) without a `table` float. Put `\caption{..}\label{tab:<name>}\\` first, repeat the header with `\endfirsthead` / `\endhead`, add a "continued" footer with `\endfoot` and a final `\endlastfoot`. `S` columns work in longtable too.

## Insert

Add `\input{tables/<name>}` at the requested spot, on its own line, and reference it from the prose with `\cref{tab:<name>}` if the text does not already.

## Verify

1. `ternlatex build`; fix any error or overfull `\hbox` warning that points at the table.
2. `ternlatex snapshot tables/<name>.tex:1` (or `--page N`) and read the PNG: check alignment on the decimal point, header wrapping, width against the text block, and that the float landed near its reference.
3. Fix and repeat until clean, then `ternlatex show tables/<name>.tex:1`.
