#!/usr/bin/env python3
"""Repair ONNX's embedded framework metadata before the app is signed.

Xcode can link the static ONNX package into a dynamic framework with the app's
deployment target while copying the vendor's older MinimumOSVersion unchanged.
App Store Connect rejects that mismatch with ITMS-90208. Only the build product
is modified; package checkouts and the binary's deployment target stay intact.
Upstream: https://github.com/microsoft/onnxruntime/issues/27396
"""
import os
from pathlib import Path
import plistlib
import re
import subprocess


def version(value):
    return tuple(int(part) for part in value.split('.')) + (0,) * (3 - len(value.split('.')))


def main():
    framework = Path(os.environ['TARGET_BUILD_DIR']) / os.environ['FRAMEWORKS_FOLDER_PATH'] / 'onnxruntime.framework'
    plist_path = framework / 'Info.plist'
    if not plist_path.is_file():
        raise SystemExit(f'Expected embedded ONNX framework: {framework}')
    info = plistlib.loads(plist_path.read_bytes())
    binary = framework / info['CFBundleExecutable']
    output = subprocess.check_output(['/usr/bin/xcrun', 'vtool', '-show-build', str(binary)], text=True)
    # vtool also prints linker versions beneath "tool LD". Read the OS field
    # from LC_BUILD_VERSION explicitly for the supported modern iOS artifacts.
    minimums = re.findall(r'^\s*minos\s+(\d+(?:\.\d+){1,2})\s*$', output, re.MULTILINE)
    if not minimums:
        raise SystemExit('ONNX binary has no readable LC_BUILD_VERSION minimum OS')
    required = max(minimums, key=version)
    app_target = os.environ['IPHONEOS_DEPLOYMENT_TARGET']
    if version(required) > version(app_target):
        raise SystemExit(f'ONNX needs iOS {required}, exceeding app target {app_target}; rebuild the dependency')
    previous = info.get('MinimumOSVersion')
    if previous == required:
        print(f'ONNX MinimumOSVersion already matches its binary: {required}')
        return
    info['MinimumOSVersion'] = required
    with plist_path.open('wb') as file:
        plistlib.dump(info, file, fmt=plistlib.FMT_BINARY, sort_keys=False)
    if os.environ.get('CODE_SIGNING_ALLOWED') != 'NO':
        identity = os.environ.get('EXPANDED_CODE_SIGN_IDENTITY')
        if not identity:
            raise SystemExit('Cannot re-sign the corrected framework without a code signing identity')
        subprocess.run(['/usr/bin/codesign', '--force', '--sign', identity,
                        '--preserve-metadata=identifier,entitlements,flags', '--timestamp=none', str(framework)], check=True)
        subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(framework)], check=True)
    print(f'Corrected ONNX MinimumOSVersion: {previous} -> {required}; app target remains {app_target}')


if __name__ == '__main__':
    main()
