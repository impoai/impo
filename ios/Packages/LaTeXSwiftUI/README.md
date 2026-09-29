# LaTeXSwiftUI for Impo

Vendored from [LaTeXSwiftUI 1.5.0](https://github.com/colinc86/LaTeXSwiftUI/tree/1.5.0),
commit `c45e0fd45f64923c49c5904a9f9626bc8939f05f`, under its included MIT license.
Sources, package configuration and upstream tests are retained.

The only source patch is in `TeXInputProcessorOptions+Extensions.swift`: explicitly
escape decimal dots in the MathJax number pattern. MathJaxSwift 3.5.0's default
pattern consumes closing braces after numbers, rejecting valid expressions such
as `x^{n-1}` and `x^{2}`. Impo's native response tests exercise the patched options
against the actual offline SVG renderer. Remove this patch when the upstream
configuration is corrected and the same tests pass.
