# Native speech detector test fixtures

`speech-en.wav` and `speech-zh.wav` are copied unchanged from
`ios/App/NativeTests/Fixtures`. They were synthesized locally with macOS `say`
(Samantha and Tingting) and converted to mono 16 kHz PCM with `afconvert`.
They ship only in the instrumentation test APK. They verify the actual bundled
Silero model and Android ONNX Runtime, not a physical microphone.
