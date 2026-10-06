# Official template sources

Checked 2026-10-02. Order of preference: venue/publisher author-kit page, then CTAN, then the venue's official GitHub, then (last resort) an Overleaf gallery copy marked "Official".
**Year-specific** kits change every edition: always open the current year's call for papers / author instructions and take the link from there; the URLs below show the pattern.

| Venue family | Author-kit page | CTAN | Official GitHub | Notes |
| --- | --- | --- | --- | --- |
| IEEE conferences | https://www.ieee.org/conferences/publishing/templates | https://ctan.org/pkg/ieeetran (zip: https://mirrors.ctan.org/macros/latex/contrib/IEEEtran.zip) | — | IEEEtran 1.8b is the current release and is in the bundle. The conference may add its own instructions (page limit, PDF eXpress ID). |
| IEEE journals | https://template-selector.ieee.org/ and the IEEE Author Center "IEEE article templates" page (blocks curl; open in the browser block) | as above | — | Some Transactions ship their own class; the selector names it. |
| ACM (all venues) | https://www.acm.org/publications/proceedings-template (blocks curl) | https://ctan.org/pkg/acmart (zip: https://mirrors.ctan.org/macros/latex/contrib/acmart.zip) | https://github.com/borisveytsman/acmart | CTAN ships `acmart.dtx`/`.ins` only; generate the `.cls` (see SKILL.md). Bundle has v1.83 (2022); CTAN has v2.20 (2026-08-16), which builds under Tectonic. ACM TAPS checks the acmart version at camera-ready: vendor the current one. |
| Springer LNCS / CCIS / LNBI | https://www.springer.com/gp/computer-science/lncs/conference-proceedings-guidelines | https://ctan.org/pkg/llncs (v2.26, 2025-02-25) | — | Bundle llncs 2.21. Use `splncs04.bst`. Licence CC BY 4.0. |
| Springer Nature journals | https://www.springernature.com/gp/authors/campaigns/latex-author-support | — | — | `sn-jnl.cls` is not in the bundle; download the kit. Kit ships several `.bst` files (`sn-mathphys-num`, `sn-basic`, ...). |
| Elsevier journals | https://www.elsevier.com/researcher/author/policies-and-guidelines/latex-instructions | https://ctan.org/pkg/elsarticle (v3.5, 2026-01-09) | — | Bundle elsarticle 3.3 (2020/11/20) and the CAS classes (`cas-sc`, `cas-dc`). Some journals require CAS; check the journal's "Guide for authors". |
| APS (PRL, PRA–PRX) / AIP | https://journals.aps.org/revtex | https://ctan.org/pkg/revtex (4.2f) | — | Bundle revtex 4.2e (2020/10/03); fine for submission. |
| AMS | https://www.ams.org/publications/authors/tex/amslatex | https://ctan.org/pkg/amscls | — | amsart 2.20.6 in bundle (current). |
| NeurIPS | https://neurips.cc/Conferences/2026/CallForPapers | — | — | **Year-specific.** 2026 kit: https://media.neurips.cc/Conferences/NeurIPS2026/Formatting_Instructions_For_NeurIPS_2026.zip (`neurips_2026.sty` 2026-01-29, `neurips_2026.tex`, `checklist.tex`). Earlier years: `media.neurips.cc/Conferences/NeurIPS<YEAR>/Styles.zip`. No explicit licence in the files; Overleaf lists it CC BY 4.0. |
| ICML | https://icml.cc/Conferences/2026/AuthorInstructions | — | — | **Year-specific.** 2026 kit: https://media.icml.cc/Conferences/ICML2026/Styles/icml2026.zip (`icml2026.sty`, `icml2026.bst`, `algorithm(ic).sty`, `fancyhdr.sty`, `example_paper.tex`). |
| ICLR | https://iclr.cc/Conferences/2026/AuthorGuide | — | https://github.com/ICLR/Master-Template (folder `iclr<YEAR>/`, zip `raw/master/iclr<YEAR>.zip`) | **Year-specific.** |
| ACL / EMNLP / NAACL / EACL (*ACL) | https://acl-org.github.io/ACLPUB/ | — | https://github.com/acl-org/acl-style-files (zip: `archive/refs/heads/master.zip`) | Not year-specific: one `acl.sty` + `acl_natbib.bst` for all *ACL venues; options `review`, `final`, `preprint`. No licence file in the repo. |
| University theses | the university's corporate-design / graduate-school page (e.g. TUM: https://portal.mytum.de/corporatedesign, often login-gated) | — | the chair's or student council's GitHub/GitLab | Many are unofficial; prefer what the graduate school or examination office links. If the official kit is behind a login, ask the user to drop the zip into the project. Fall back to `classicthesis`, KOMA `scrbook`/`scrreprt` or `memoir` plus the university's title-page rules. |
| CV | — | https://ctan.org/pkg/moderncv | https://github.com/moderncv/moderncv | Bundle moderncv 2.3.1 (2022-02-21). |
| Posters | — | https://ctan.org/pkg/tikzposter, https://ctan.org/pkg/beamerposter | baposter: no CTAN package (only copies on the author's site / Overleaf) | Prefer tikzposter or beamerposter (both in bundle). |
| Tufte | — | https://ctan.org/pkg/tufte-latex | https://github.com/Tufte-LaTeX/tufte-latex | Apache-2.0. |

## Licences seen on CTAN

IEEEtran, acmart, elsarticle: LPPL 1.3. revtex, amscls, memoir, KOMA-Script, moderncv: LPPL 1.3c. llncs: CC BY 4.0. tikzposter, a0poster: LPPL 1.2. beamerposter: LPPL or GPL. classicthesis: GPL 2+. tufte-latex: Apache 2.0.
Venue-hosted kits (NeurIPS, ICML, ICLR, ACL, university theses) usually carry no licence statement: they are distributed for authors to use for that venue. Keep them in the paper's own repository; do not republish them as a separate package.
