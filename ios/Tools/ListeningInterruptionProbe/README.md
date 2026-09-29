# Microphone interruption qualification probe

An isolated local test app (`ai.impo.interruptionqa`). It activates a non-mixing microphone session, discards input immediately, and explicitly releases audio with `notifyOthersOnDeactivation`. Its optional music button runs a looping, muted AVAudioPlayer with a non-mixing playback session, allowing both activation orders to be tested without audible noise. It has no persistent storage or network code and is never embedded in Impo. Build it only for a test device/simulator, grant microphone access, then run the opt-in cross-app test in `ListeningCaptureLiveUITests` with both `IMPO_UI_LIVE_BACKEND` and `IMPO_MICROPHONE_PROBE=1` passed to the test runner. Remove the probe when finished.

For a simulator, from the repository root:

```sh
mkdir -p .local
cp -R ios/Tools/ListeningInterruptionProbe .local/ListeningInterruptionProbe
xcodegen generate --spec .local/ListeningInterruptionProbe/project.yml
xcodebuild -project .local/ListeningInterruptionProbe/ImpoMicProbe.xcodeproj -scheme ImpoMicProbe -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath .local/ListeningInterruptionProbe/DerivedData build
# Substitute the dedicated test simulator's UDID below.
xcrun simctl install TEST_SIMULATOR_UDID .local/ListeningInterruptionProbe/DerivedData/Build/Products/Debug-iphonesimulator/ImpoMicProbe.app
xcrun simctl privacy TEST_SIMULATOR_UDID grant microphone ai.impo.interruptionqa
```

A physical device requires its own development signing configuration. The test expects a real system interruption and fails if one isn't observed; it does not inject a notification to simulate hardware qualification. On 2026-09-27, iOS 26.5 Simulator kept Impo's active status when this probe started input, so the cross-app test did **not** qualify interruption/resumption there. Physical iPhone verification remains required. Controller tests separately inject events and check actual notification parsing; those results are not device qualification.
