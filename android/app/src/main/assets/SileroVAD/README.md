# Bundled Silero VAD

The Android client uses the same unmodified MIT-licensed Silero v6.2.3 model as
the iOS client. Upstream: https://github.com/snakers4/silero-vad, commit
`5cd7945676eb32225748052e2e6a0580e4686a08`.

`silero_vad.onnx`: 2,327,524 bytes; SHA-256
`1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`.
The MIT license is included in `LICENSE.txt`. ONNX Runtime Android is pinned to
1.24.2. Inference runs locally with mono 16 kHz PCM, 512 new samples, 64 context
samples and recurrent state `[2,1,128]`. Every recording/resume creates fresh
model state. No audio is sent to Silero or Microsoft.
