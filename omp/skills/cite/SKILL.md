---
name: cite
description: Cite a work from the user's Zotero library ("cite the Smith 2020 paper on X here"); finds it with `ternlatex refs search`, inserts \cite/\citet/\citep with the item's real citation key, imports the bib entry and verifies the build.
---

# Cite

Arguments: a description of the work (author, year, title words, topic) and where the citation goes (file:line, "here", "after the sentence about X").

## Find the item

1. `ternlatex refs search QUERY…` with the most distinctive words: an author surname, then title words if needed. Zotero's quick search matches title, creators and year as a phrase, so search `smith`, not `smith 2020 deep learning`, and filter the results yourself.
   Output is one line per item: `key<TAB>year<TAB>creators<TAB>title`. `--limit N` (default 25) widens the list.
2. Pick the line whose year, creators and title fit the request. If several fit, or none clearly does, show the candidates (key, year, creators, title) and ask the user. Never invent a key, and never cite a work that is not in their library.
3. No match: try another term (other author, a title word). If nothing turns up, tell the user the work is not in their Zotero library; do not hand-write a bib entry unless asked.

The first column is the key ternlatex writes into the bib (Zotero's citation key field, a Better BibTeX key, or Zotero's generated key), so cite exactly that string.

## Insert

- Read the preamble to see the citation package.
  - natbib (`\usepackage{natbib}`, the templates' default): `\citet{key}` when the authors are part of the sentence ("\citet{key} showed …"), `\citep{key}` for a parenthetical reference at the end of a claim. `\citep[p.~12]{key}` for a page, `\citep[see][]{key}` for a prefix.
  - biblatex: `\textcite{key}` / `\parencite{key}` (or `\autocite`) with the same distinction.
  - Neither: plain `\cite{key}`.
- Follow the project's existing habits (look at a few existing citations): tie with `~` before `\cite` if the text does, merge into an existing `\citep{a, key}` when citing together.
- Put the citation where the claim is, before the sentence's final punctuation.

## Import and verify

1. `ternlatex refs add key` appends the entry to the project's bib file (`[zotero] bib` in ternlatex.toml, default refs.bib) under a `% Imported from Zotero by ternlatex` comment. It never rewrites existing entries and skips keys that are already defined.
   - `missing: key` means the key did not resolve in Zotero; recheck it with `refs search`.
   - An error naming "Allow other applications on this computer to communicate with Zotero" means the Zotero desktop app is closed or that setting is off: ask the user to start Zotero and enable it (Settings → Advanced). A 403 from api.zotero.org means ZOTERO_API_KEY is missing or lacks access.
2. `latex_build`: there must be no `Citation … undefined` warning for the key.
3. `latex_show` at the citation's `file:line` to reveal it in the viewer.

`ternlatex refs sync` imports every cited key that no .bib file defines yet. With `auto_import = true` (the default), the dev server does this on save when a build reports undefined citations, so a correct key in the text usually resolves by itself; `refs add` makes it explicit and reports problems immediately.
