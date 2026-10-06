---
name: style
description: Change the document's look (fonts, colours, headings, margins, captions, headers/footers, title page) by editing only the project's style file, verifying with before/after page snapshots.
---

# Style

Arguments: what to change ("use TeX Gyre Pagella", "narrower margins", "numbered headings in sans", "make it look like an IEEE paper").

## Where

Edit only `style/ternlatex.sty`. In imported projects without it, edit the existing style file or preamble that holds the current styling. Never put styling into body files. Every option in `ternlatex.sty` is grouped by section with commented alternatives; change those first before adding new code.

## Before

1. `latex_snapshot` of page 1 and of a typical body page (one with a heading, a float and a caption). Look at the images.
2. Read the relevant section of the style file.

## Knobs

- Fonts: `\setmainfont`, `\setsansfont`, `\setmonofont`, `\setmathfont` (unicode-math). Use fonts from the Tectonic bundle by file name for reproducibility, e.g. Libertinus (`LibertinusSerif`), TeX Gyre (`texgyrepagella`, `texgyretermes`, `texgyreheros` with `UprightFont=*-regular`), Latin Modern, Fira (`FiraSans`, `FiraMono`), with matching math fonts (`LibertinusMath-Regular.otf`, `texgyrepagella-math.otf`, `latinmodern-math.otf`). Project fonts: put them in `fonts/` and add `Path = fonts/`. System fonts work but are not reproducible; warn if the user asks for one.
- Colours: change the palette (`tlaccent`, `tlmuted`, `tlrule`, `tlcodebg`, `tlwarn`) rather than individual uses. Add new named colours to the palette, never raw values elsewhere.
- Headings: the `titlesec` block (`\titleformat`, `\titlespacing*`).
- Margins/paper: the `geometry` options.
- Captions: the `\captionsetup` block.
- Headers/footers: the `fancyhdr` block (`tlplain` style, commented running-header variant).
- Title page: the `titling` block (`\pretitle`, `\posttitle`, `\tltitlefont`) or a custom `\maketitle` in the style file.
- Beamer: the `\setbeamercolor`/`\setbeamerfont`/`\setbeamertemplate` block; geometry, caption and titlesec do not apply there.

Keep the existing load order: hyperref, then cleveref, last.

## After

1. `latex_build`; no new errors or warnings. Font changes often cause missing-glyph warnings (`Missing character`): fix or pick another font.
2. Snapshot the same pages and compare with the before images. Check that text did not reflow into new overfull boxes.
3. `latex_show` a representative spot and summarise what changed.
