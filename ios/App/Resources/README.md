# App resources

`Assets.xcassets` contains the app icon, mark, assistant avatars and illustrations
used by the native interface. These are product assets, not reference screenshots.
The website has its own required assets under `site/assets/`.

`SileroVAD/` contains the pinned on-device speech detector and its upstream license.
See its [README](SileroVAD/README.md) for model provenance and packaging checks.
Native test audio lives only in `../NativeTests/Fixtures/`, with source and license
information in that directory. Test recordings must never enter the app bundle.
