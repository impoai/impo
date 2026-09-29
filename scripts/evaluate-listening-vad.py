#!/usr/bin/env python3
"""Repeatable, local-only Silero smoke evaluation; no transcription API calls.

uv run --with onnxruntime==1.24.2 --with numpy scripts/evaluate-listening-vad.py \
    --metro .local/vad-evaluation/metro.wav --output .local/vad-evaluation/benchmark.json

Metro retention is NOT a false-positive rate: DEMAND contains real background
events and is not annotated as speech-free. Synthetic mixing is not iPhone QA.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time
import wave

import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / 'ios/App/Resources/SileroVAD/silero_vad.onnx'
FIXTURES = ROOT / 'ios/App/NativeTests/Fixtures'


def read(path):
    with wave.open(str(path)) as file:
        assert file.getframerate() == 16000 and file.getnchannels() == 1
        assert file.getsampwidth() == 2
        return np.frombuffer(file.readframes(file.getnframes()), dtype='<i2').astype(np.float32) / 32768


def rms(samples):
    return float(np.sqrt(np.mean(samples ** 2)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--metro', type=Path, default=FIXTURES / 'metro-30s.wav')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    digest = hashlib.sha256(MODEL.read_bytes()).hexdigest()
    assert digest == '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3'
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.add_session_config_entry('session.intra_op.allow_spinning', '0')
    session = ort.InferenceSession(str(MODEL), sess_options=options, providers=['CPUExecutionProvider'])

    def analyze(name, samples):
        started = time.perf_counter()
        state = np.zeros((2, 1, 128), dtype=np.float32)
        context = np.zeros(64, dtype=np.float32)
        consecutive = voiced = 0
        accepted = False
        for offset in range(0, len(samples), 512):
            frame = samples[offset:offset + 512]
            padded = np.pad(frame, (0, 512 - len(frame)))
            audio = np.concatenate((context, padded)).reshape(1, 576)
            probability, state = session.run(['output', 'stateN'], {
                'input': audio, 'state': state, 'sr': np.array([16000], dtype=np.int64)})
            context = padded[-64:]
            if float(probability.flat[0]) >= 0.5:
                voiced += len(frame)
                consecutive += len(frame)
                accepted |= consecutive >= 1536
            else:
                consecutive = 0
        # Approximate old recorder energy meter with 250 ms RMS windows.
        audible = sum(rms(samples[i:i + 4000]) > 10 ** (-45 / 20)
                      for i in range(0, len(samples), 4000))
        return dict(name=name, duration_seconds=len(samples) / 16000,
                    old_energy_gate=audible >= 3, silero_gate=accepted,
                    predicted_speech_seconds=voiced / 16000,
                    processing_seconds=time.perf_counter() - started)

    metro = read(args.metro)
    rows = [analyze('digital-silence', np.zeros(16000 * 30, dtype=np.float32))]
    rng = np.random.default_rng(42)
    rows.append(analyze('white-noise', rng.uniform(-0.1, 0.1, 16000 * 30).astype(np.float32)))
    for lang in ('en', 'zh'):
        speech = read(FIXTURES / f'speech-{lang}.wav')
        rows.append(analyze(f'synthetic-{lang}-clean', speech))
        background = np.resize(metro, len(speech))
        for snr in (10, 0, -5):
            noise_scale = rms(speech) / (rms(background) * 10 ** (snr / 20))
            mixed = speech + background * noise_scale
            mixed /= max(1, float(np.max(np.abs(mixed))))
            rows.append(analyze(f'synthetic-{lang}-metro-{snr}dB', mixed))
    # Keep exactly the production 30-second decision granularity.
    for offset in range(0, len(metro) - 16000 + 1, 16000 * 30):
        rows.append(analyze(f'metro-{offset // 16000}s', metro[offset:offset + 16000 * 30]))
    report = dict(model_sha256=digest, runtime=ort.__version__, backend='host CPU reference',
                  limitations=['Not physical iPhone microphone/battery validation',
                               'Metro is not speech-free ground truth',
                               'Whole-clip speech detection is not word recall or transcription accuracy'],
                  samples=rows)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
