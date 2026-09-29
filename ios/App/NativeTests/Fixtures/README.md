# Listening VAD fixtures (test bundle only)

`speech-en.wav` and `speech-zh.wav` are synthetic, generated locally with macOS
`say` (Samantha and Tingting), converted to mono 16 kHz with `afconvert`.
The English fixture says: "I am riding the subway. Please keep the words I am
saying, even when the train gets loud." The Mandarin fixture describes riding
the subway in loud surroundings and asks that background noise not be mistaken
for speech. The audio deliberately covers both languages.
These test the actual bundled model; they do not validate a physical microphone.

`metro-30s.wav` is the first 30 seconds of channel 1 of DEMAND `TMETRO_16k.zip`.
Source: https://zenodo.org/records/1227121
Creators: Joachim Thiemann, Nobutaka Ito, Emmanuel Vincent.
License: CC BY-SA 3.0, https://creativecommons.org/licenses/by-sa/3.0/
Modification: first 30 seconds extracted from `TMETRO/ch01.wav`; no other change.
Original archive MD5: `95daf4df678e13b120e14211e6d89571`.
This is a real environment recording, not a speech-free annotated dataset:
retention measures are not labeled false-positive rates. Do not infer broad
subway accuracy from one excerpt or from synthetic speech mixed into it.
