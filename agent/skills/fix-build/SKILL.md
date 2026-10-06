---
name: fix-build
description: Diagnose and fix a failing or warning-laden LaTeX build under Tectonic, starting from build/status.json or ternlatex build output and fixing the first error first until the build is clean.
---

# Fix build

## Loop

1. Run `ternlatex build` (or read `build/status.json` if the dev server just built). Diagnostics are `file:line: severity: message`.
2. Fix the first error only. Later errors usually cascade from it.
3. Rebuild. Repeat until there are no errors.
4. Then handle warnings: undefined references/citations, overfull boxes, missing characters.
5. If an error points into a package (`something.sty:123`), the cause is almost always the last thing in the project's own source before that point; read `build/main.log` around the error for the source line.

Never paper over an error by deleting content or commenting out a package the document needs. If a fix changes what the document says or how it looks, tell the user.

## Tectonic gotchas

- Package not found: the bundle is pinned TeX Live 2022. Check the name (`\usepackage` names are case-sensitive). If it is genuinely missing, use an equivalent from the bundle, or vendor the `.sty` into the project only if its licence allows.
- `\write18`, `--shell-escape`, `minted`, `svg`, `epstopdf` conversion, `gnuplottex`: unavailable (no shell escape). Use `listings` instead of `minted`; convert SVG/EPS to PDF outside LaTeX and commit the PDF in `figures/`.
- biblatex with biber: unavailable. Switch to bibtex + natbib: replace `\usepackage[...]{biblatex}` with natbib, `\addbibresource{refs.bib}` with `\bibliographystyle{plainnat}` + `\bibliography{refs}` at the end, `\printbibliography` likewise, `\textcite` with `\citet`, `\parencite` with `\citep`, `\autocite` with `\citep`. biblatex `backend=bibtex` also works if the style allows it. Tectonic runs bibtex automatically.
- pdfLaTeX-only code: `\usepackage[T1]{fontenc}`, `inputenc`, `\pdfoutput`, `pdftex` options. XeTeX takes UTF-8 input directly; replace font packages (`times`, `mathptmx`, `lmodern`) with `fontspec` settings in the style file.
- Missing character warnings: the current font lacks the glyph; choose a font that has it or use a command for the symbol.
- Fonts not found: use bundle font file names (`LibertinusSerif-Regular.otf`) rather than family names, or put the font in `fonts/` with `Path = fonts/`.
- `Object @page.1 already defined`: duplicate page numbers (title page in report/book); use distinct `\pagenumbering` for front matter.
- First build after adding a package is slower: Tectonic downloads it.

## Done

The build exits 0, `ternlatex build` shows no errors, and you have listed what you changed and why.
