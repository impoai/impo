# Bundled Silero VAD

- Upstream: https://github.com/snakers4/silero-vad
- Release: `v6.2.3`, commit `5cd7945676eb32225748052e2e6a0580e4686a08`
- File: `src/silero_vad/data/silero_vad.onnx` (2,327,524 bytes)
- SHA-256: `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`
- License: MIT; included in `LICENSE.txt`.
- Runtime: Microsoft ONNX Runtime 1.24.2, pinned in XcodeGen / Package.resolved.

The app performs inference locally, without downloading a model or sending audio
to Silero/Microsoft. The native C++ runtime is accessed through Microsoft's
Objective-C bindings from Swift. No separate Python runtime is shipped.

Input is mono 16 kHz Float32, 512 samples per step with 64 context samples and
recurrent state `[2, 1, 128]`. Reset state and context for each recording. The
shipping model is shared with the native tests; fixtures are test-only resources.

## App Store packaging

With Xcode 27, the embedded framework binary is linked for the app's iOS 18
deployment target, but the vendor Info.plist retains MinimumOSVersion 15.1.
Apple rejected Build 8 with ITMS-90208. The app's post-build phase runs
`scripts/fix-onnx-framework.py` to read the binary's actual minimum OS, reject
any dependency that requires a newer OS than the app supports, align only the
copied framework's plist, and re-sign that framework before the app is signed.
The package cache, binary deployment target, and app's iOS 18 support are not
modified. Upstream issue: https://github.com/microsoft/onnxruntime/issues/27396

Release verification must inspect both the archive and exported IPA, verify
signatures, and wait for App Store Connect processing to report VALID. An
upload success alone does not qualify a TestFlight build.
