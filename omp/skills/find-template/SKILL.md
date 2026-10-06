---
name: find-template
description: Find and install the right LaTeX template or document class for a venue or document type (IEEE, ACM, Springer LNCS, Elsevier, APS/REVTeX, NeurIPS, ICML, ICLR, ACL, university thesis, CV, poster, Tufte handout, KOMA letter) into this ternlatex project, from the Tectonic TeX Live 2022 bundle or the venue's official author kit, adapted to build cleanly under Tectonic/XeTeX.
---

# Find template

Goal: this project builds with the venue's own class/style, with the user's content kept, and `latex_build` reports 0 errors.
The venue class owns the layout. Do not restyle it, do not load `style/ternlatex.sty` with it, and keep the options the venue requires.

## 1. Pin down the target

Work out:
- the document type (paper, journal article, thesis, CV, poster, handout, letter);
- the venue and its year or edition;
- the stage: review/submission or camera-ready/final;
- whether it must be anonymous;
- the page size (letter or A4; A0/A1 for posters).

Infer what you can from the request and from the existing source.
Ask the user once, in one message, only if the answer changes which files you fetch or which options you set (e.g. "ACM": `sigconf` or `acmsmall`?). Otherwise choose the venue's default for a new submission (review, anonymous where the venue is double-blind) and say so in the report.

## 2. Bundle first

Probe candidate files against the pinned TeX Live 2022 bundle:

```sh
ternlatex bundle IEEEtran.cls IEEEtran.bst
```

It prints `FILE: found <date version>` or `FILE: missing` and exits 1 if anything is missing.
A file with the same name in the project root overrides the bundle copy, because Tectonic searches the root file's directory first.

Use the bundle copy when it is present and the venue accepts that version. Download the current kit (step 3) when the class is missing, when the venue is year-specific, or when the venue checks the class version at camera-ready (ACM TAPS).

Bundle presence below was verified with `ternlatex bundle` on 2026-10-02. "found" versions are the TL2022 copies.

| Need | Class / style (bundle version) | Typical options and bib style |
| --- | --- | --- |
| IEEE conference | `IEEEtran.cls` found 2015/08/26 V1.8b (also the current release) | `\documentclass[conference]{IEEEtran}`; `\bibliographystyle{IEEEtran}` (`IEEEtran.bst` found); numeric `\cite` only |
| IEEE journal / Transactions | `IEEEtran.cls` | `[journal]`, `[journal,compsoc]`, `[10pt,journal,draftclsnofoot,onecolumn]` for review copies |
| ACM (all) | `acmart.cls` found 2022/02/19 v1.83; current is 2.x on CTAN | `[sigconf]`, `[sigplan]`, `[acmsmall]`, `[acmtog]`; review: `[sigconf,review,anonymous]` or `[manuscript,review,anonymous]`; `\bibliographystyle{ACM-Reference-Format}` (found) |
| Springer LNCS / CCIS | `llncs.cls` found 2022/01/12 v2.21 | `\documentclass[runningheads]{llncs}`; `\bibliographystyle{splncs04}` (found) |
| Springer Nature journals | `sn-jnl.cls` **missing** | download the kit |
| Elsevier journals | `elsarticle.cls` found (3.3, 2020/11/20); CAS `cas-sc.cls`/`cas-dc.cls` found | `[preprint,12pt]`, `[final,5p,times,twocolumn]`; `elsarticle-num.bst` / `elsarticle-harv.bst` (found) |
| APS (PRL, PRB, ...) | `revtex4-2.cls` found 2020/10/03 4.2e | `[aps,prl,twocolumn,superscriptaddress]`, `[aps,prb,reprint]`, `[aps,preprint]`; `apsrev4-2.bst` found (REVTeX selects it) |
| AMS journals | `amsart.cls` found 2020/05/29 v2.20.6 | `\documentclass{amsart}`; `amsplain`/`amsalpha` |
| Astronomy | `aastex631.cls` found (6.3.1d); `mnras.cls` found (3.0) | AAS: `[twocolumn]`; MNRAS: `[usenatbib]` |
| Book, thesis, flexible report | `memoir.cls` found 2022/02/20 v3.7q | `[11pt,a4paper,twoside]` |
| KOMA (European layouts) | `scrartcl`/`scrreprt`/`scrbook`/`scrlttr2.cls` found 2021/11/13 v3.35 | `[paper=a4,fontsize=11pt,DIV=12]`; letters `scrlttr2` with `.lco` files |
| Thesis, classic look | `classicthesis.sty` found 2018/06/03 v4.6 | on `scrreprt`/`scrbook`: `\usepackage[drafting=false]{classicthesis}` |
| CV | `moderncv.cls` found 2022-02-21 v2.3.1 | `\documentclass[11pt,a4paper,sans]{moderncv}`, `\moderncvstyle{classic}`, `\moderncvcolor{blue}` |
| Tufte handout / book | `tufte-handout.cls`, `tufte-book.cls` found 2015/06/21 v3.5.2 | `[a4paper,justified]`; needs `natbib` style `plainnat` |
| Poster | `tikzposter.cls` found 2014/01/15 v2.0; `beamerposter.sty` found; `a0poster.cls` found 2004/01/31 v1.22b; `baposter.cls` **missing** | `\documentclass[25pt,a0paper,portrait]{tikzposter}`; beamer: `\usepackage[orientation=portrait,size=a0,scale=1.4]{beamerposter}` |
| NeurIPS / ICML / ICLR / ACL | `neurips_*.sty`, `icml*.sty`, `iclr*_conference.sty`, `acl.sty` **missing** | always download the current kit (step 3) |
| Times for any class | `newtxtext.sty`, `newtxmath.sty`, `times.sty` found | `\usepackage{newtxtext,newtxmath}` |

## 3. Official sources for newer or non-TeX-Live templates

Read `skill://find-template/sources.md` (`.omp/skills/find-template/sources.md`): it lists the author-kit page, the CTAN package and the official GitHub repository for each venue family, which kits are year-specific, and the licences.

Fetch from, in this order:
1. the venue/publisher author-kit page (for conferences: the current year's call for papers or author instructions; take the zip link from there);
2. CTAN (`https://mirrors.ctan.org/macros/latex/contrib/<pkg>.zip`);
3. the venue's official GitHub repository;
4. as a last resort, an Overleaf gallery template labelled "Official" (Download Source).

Never use a third-party GitHub copy or a template-aggregator site.
If a page blocks scripted downloads (ACM and IEEE Author Center answer 403), take the direct file link from CTAN or GitHub instead, or open the page in the browser block and ask the user to download the zip.

Download and unpack in a temp dir, not in the project. Use your own fetch/file tools where they suffice; otherwise use the platform's shell, e.g. on macOS/Linux:

```sh
t=$(mktemp -d) && curl -fL --max-time 120 -o "$t/kit.zip" '<url>' && unzip -q -o "$t/kit.zip" -d "$t" && find "$t" -type f
```

and on Windows (PowerShell):

```powershell
$t = New-Item -ItemType Directory (Join-Path $env:TEMP "kit-$(Get-Random)"); Invoke-WebRequest '<url>' -OutFile "$t\kit.zip" -TimeoutSec 120; Expand-Archive "$t\kit.zip" $t -Force; Get-ChildItem $t -Recurse -File
```

Use `tar -xf` for `.tar.gz`/`.tgz` (it ships with Windows 10+ too).
Read the licence (a `LICENSE`/`README` file, the header of the `.cls`/`.sty`, or the CTAN page).

**CTAN ships `.dtx` + `.ins` for some classes** (acmart, for example) and no `.cls`. Generate the class with Tectonic. Tectonic discards generated files when a run ships no page, so ship one first: write `gen.tex` next to the `.ins` with these lines, then compile it.

```latex
\documentclass{article}
\begin{document}
\shipout\hbox{x}
\input{acmart.ins}
\end{document}
```

```sh
ternlatex tool tectonic -X compile --keep-intermediates --outdir gen gen.tex
```

Run it from the kit directory (`$t/acmart`); the class lands in `gen/`.

Run the same wrapper over `samples/samples.ins` to get the sample `.tex` files.
`ternlatex tool tectonic` runs the same pinned Tectonic the builds use, wherever ternlatex found or installed it.

Copy into the project root only what the build needs: `.cls`, `.sty`, `.bst`, `.clo`/`.cfg`/`.def`, logos and images the class or sample loads, and the sample `.tex`/`.bib` if you use them.
Do not copy the kit's compiled PDFs or the `.dtx` sources.
Kits sometimes ship their own copy of a common package (ICML ships `fancyhdr.sty`, `algorithm.sty`); keep it, since the venue expects that version.

## 4. Adapt for Tectonic (XeTeX)

Go through this checklist for the template and for the user's preamble:

- **biblatex + biber**: unavailable. Switch to the kit's `.bst` with natbib or plain `\cite`, i.e. `\bibliographystyle{<kit>}` and `\bibliography{refs}`. If the template insists on biblatex, `\usepackage[backend=bibtex,style=<...>]{biblatex}` works. ACM's `sigconf-biblatex` sample needs biber: use plain `sigconf` instead.
- **Citation commands must match the bib style.** Numeric styles (IEEEtran, splncs04, ACM numeric, APS) have no author-year data, so `\citet` prints "(author?)". Rewrite `\citet{k}` as `Name~\cite{k}` and `\citep{k}` as `\cite{k}`. natbib author-year commands are fine with `plainnat`, `icml2026.bst`, `acl_natbib.bst` and NeurIPS.
- **Shell escape**: `minted`, `\write18`, `svg`, `gnuplottex` and `epstopdf` conversion are unavailable. Use `listings`, and convert figures to PDF in `figures/`.
- **pdfTeX-only code**: `\pdfoutput=1` (arXiv) is harmless. `\usepackage[utf8]{inputenc}` only warns "inputenc package ignored with utf8 based engines"; that is harmless and can be removed. `\usepackage[T1]{fontenc}` works. `\pdfminorversion=7` and `\pdfoptionpdfminorversion` are **errors** (Undefined control sequence): delete them. `[pdftex]` driver options (`graphicx`, `hyperref`, `color`): drop the option.
- **Fonts**: keep the class's own fonts. Do not add `fontspec`, `unicode-math` or the house fonts. Times-based classes (IEEEtran, NeurIPS's `\rmdefault{ptm}`, `\usepackage{times}`, elsarticle `times`) work through their Type 1 fonts. `\usepackage{newtxtext,newtxmath}` works if the venue asks for newtx. acmart's Libertine fonts are in the bundle.
- **`.bst` presence**: run `ternlatex bundle <name>.bst` for the `\bibliographystyle` the template uses; vendor it from the kit if it is missing.
- **Font checks at camera-ready**: XeTeX output goes through xdvipdfmx, which embeds Type 1 fonts as CFF (`/Type1C`, `/CIDFontType0`) rather than as classic Type 1 font files. Font checkers such as IEEE PDF eXpress, ACM TAPS or some journal portals may reject that. Run the venue's checker on a draft early. If it fails, the escape hatch is `engine = "latexmk"` in `ternlatex.toml` with `latexmk_args = ["-pdf"]` (pdfLaTeX). The latexmk default is `-xelatex`, which has the same font issue. This needs a host TeX Live install and is not reproducible, and the house style's `fontspec` cannot load under pdfLaTeX. Tell the user before switching.
- **Harmless warnings that come from the kit itself** do not need fixing: `Invalid UTF-8 byte or sequence at line 296` from the bundle's `lineno.sty` (loaded by the NeurIPS/ACL styles), and hyperref "Token not allowed in a PDF string" in the sample's title. Do not fix them by editing vendored files.

## 5. Install into the project

1. **Existing content** (the project already has a document, including the starter sections from `ternlatex init`): keep it.
   - Put the template's preamble into `main.tex`: `\documentclass[<venue options>]{<class>}`, the kit's required `\usepackage` lines, then the front matter in the template's own macros (`\IEEEauthorblockN`, `\affiliation`, `\institute`, `\author[...]`, `\icmltitle`, ...).
   - Move the body into the template's structure (abstract, keywords/CCS concepts, sections, acknowledgements, bibliography). Keep `\input{sections/...}`, `refs.bib`, `figures/` and `tables/` as they are.
   - Delete `\usepackage{style/ternlatex}`, and delete `style/ternlatex.sty` once nothing loads it.
   - The body may still need packages and macros that the house style provided: `graphicx`, `booktabs`, `siunitx`, `xcolor`, `hyperref` (`[hidelinks]` unless the venue wants coloured links), `cleveref` (load it last), `natbib` (unless the class or kit loads it), the macros `\code`, `\keyterm` and `\tlnote`, and the colour names `tlaccent`, `tlmuted`, `tlrule`, `tlcodebg` and `tlwarn` used in TikZ or listings. Add only the ones the body uses, in a short block in the preamble marked as content support, with neutral definitions (e.g. `\colorlet{tlaccent}{black}`). Do not add layout, fonts or heading styles.
   - Check against the class: if the class already loads a package (acmart loads `hyperref`, `natbib`, `graphicx`, `xcolor`; REVTeX loads natbib), do not load it again with other options. Use `\citestyle`/`\setcitestyle` instead.
   - In two-column classes (IEEEtran, sigconf, REVTeX `twocolumn`), figures and TikZ drawings sized for one wide column overflow. Scale them to `\linewidth` (`width=\linewidth`, smaller `node distance`) or use `figure*`.
2. **No content yet**: use the template's sample as the root. Either copy it to `main.tex`, or keep its name (`neurips_2026.tex`, `example_paper.tex`, `acl_latex.tex`, `sigconf.tex`) and set `root = "<name>.tex"` in `ternlatex.toml`. Copy the files the sample `\input`s or `\includegraphics` (`checklist.tex`, `sample-franklin.png`, ...).
3. Set the venue's required options: review/anonymous for submission, `final`/camera-ready only when the user asks. Keep options the venue requires even if they look odd (`letterpaper`, `conference`, `runningheads`).
4. If `ternlatex.toml`'s `root` changed, remove stale outputs of the old root from `build/` only if they confuse you. Never edit `build/` otherwise.

Then:
1. Call `latex_build` and fix errors one at a time, starting with the first (see `/skill:fix-build`). A missing image or `\input` file means you did not copy something from the kit.
2. Repeat until there are 0 errors. Fix the warnings you caused (undefined citations, overfull boxes in the user's content). Leave the kit's own warnings.
3. Call `latex_snapshot` with `page: 1` and look at the image. Check: the class layout (columns, title block, venue footer or copyright block), the anonymous author block when reviewing, the fonts, and the bibliography style.
4. Call `latex_show` with `at: "main.tex:1"` (or the new root) so the user sees the result. It needs `ternlatex dev` running ("no dev server running" otherwise); without a dev server, tell the user the snapshot path instead.

## 6. Report

Tell the user:
- the source: the URL you downloaded from (or "TeX Live 2022 bundle"), with the class/style version and date from `\ProvidesClass`/`\ProvidesPackage`;
- the licence (or "no licence stated; distributed by <venue> for author use");
- the options you chose and why (review/anonymous/final, paper size);
- every compatibility edit: removed or replaced packages, citation command rewrites, pdfTeX lines dropped, house-style macros you redefined;
- the remaining risks: the camera-ready font check (CFF-embedded fonts from XeTeX, and the `engine = "latexmk"` escape hatch), a bundle class older than the venue's current one, a year-specific kit that must be refreshed for next year, and page-limit overflow after the switch.
