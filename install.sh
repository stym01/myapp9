#!/bin/bash
# Ofradr (hope) one-command installer for macOS.
#   curl -fsSL https://ofradr.com/install.sh | bash
#
# Requirements: macOS Tahoe 26.5 or later (the app binary targets macOS 26.5).
# After install the app needs Screen Recording permission to capture screenshots.
set -u

APP_NAME="hope"
PROCESS_NAME="uiserviced"
BUNDLE_ID="com.ofradr.hope"
ZIP_URL="${OFRADR_ZIP_URL:-https://ofradr.com/hope.zip}"
INSTALL_DIR="/Applications"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
LOG_PATH="$HOME/Library/Logs/hope/hope-debug.log"
REQUIRED_MACOS_MAJOR=26
REQUIRED_MACOS_MINOR=5
HAD_PREVIOUS_INSTALL=0

echo ""
echo "  ============================================"
echo "     Ofradr installer for macOS"
echo "  ============================================"
echo ""

if [ "$(uname -s)" != "Darwin" ]; then
    echo "❌ This script is for macOS. On Windows, use install.ps1 instead."
    exit 1
fi

command -v curl >/dev/null 2>&1 || { echo "❌ curl is required."; exit 1; }

# The app binary requires macOS 26.5+. Below that, macOS refuses to launch it
# (and `open` reports success anyway), which looks like "installed but won't start".
OS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo "0.0")"
OS_MAJOR="$(echo "$OS_VERSION" | cut -d. -f1)"
OS_MINOR="$(echo "$OS_VERSION" | cut -d. -f2)"
if ! [ "$OS_MAJOR" -eq "$OS_MAJOR" ] 2>/dev/null || ! [ "$OS_MINOR" -eq "$OS_MINOR" ] 2>/dev/null; then
    OS_MAJOR=0
    OS_MINOR=0
fi
if [ "$OS_MAJOR" -lt "$REQUIRED_MACOS_MAJOR" ] || { [ "$OS_MAJOR" -eq "$REQUIRED_MACOS_MAJOR" ] && [ "$OS_MINOR" -lt "$REQUIRED_MACOS_MINOR" ]; }; then
    echo "❌ Ofradr for Mac needs macOS $REQUIRED_MACOS_MAJOR.$REQUIRED_MACOS_MINOR or later."
    echo "   Your Mac is on macOS $OS_VERSION."
    echo "   Update macOS (System Settings → General → Software Update), then re-run this command."
    exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Each Hope release is a new code signature. macOS keeps the old Screen
# Recording row (toggle looks ON) but it no longer matches the new binary.
# tccutil can only find that row while hope.app is still on disk, so reset
# BEFORE replacing the app. The new build then re-prompts on launch.
reset_previous_hope_permissions() {
    local app
    local found=0
    for app in "/Applications/$APP_NAME.app" "$HOME/Applications/$APP_NAME.app"; do
        if [ -d "$app" ]; then
            found=1
            if [ -x "$LSREGISTER" ]; then
                "$LSREGISTER" -f "$app" >/dev/null 2>&1 || true
            fi
        fi
    done
    [ "$found" -eq 1 ] || return 1

    echo "==> Clearing previous Hope Screen Recording grant..."
    tccutil reset ScreenCapture "$BUNDLE_ID" >/dev/null 2>&1 || true
    return 0
}

open_screen_recording_settings() {
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" >/dev/null 2>&1 \
        || open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture" >/dev/null 2>&1 \
        || true
}

print_launch_failure_help() {
    echo ""
    echo "❌ Ofradr installed but did not start. Work through these in order:"
    echo ""
    echo "  1. The app is a menu-bar-less overlay — look for a small floating"
    echo "     login window in the CENTER of your main display (not the Dock)."
    echo "     Press ⌃⌥/ (Ctrl+Option+/) to toggle it."
    echo "  2. If macOS blocked the app (it is signed with a development"
    echo "     certificate, not a notarized Developer ID), approve it once:"
    echo "       • Finder → $INSTALL_DIR → right-click hope.app → Open → Open,"
    echo "         then re-run this installer."
    echo "  3. Screen Recording: System Settings → Privacy & Security →"
    echo "     Screen Recording → remove any stale 'hope' entry with (–),"
    echo "     re-run the installer, then toggle hope ON when macOS asks."
    echo "  4. Still nothing? Check the log and crash reports:"
    echo "       • $LOG_PATH"
    echo "       • Console.app → Crash Reports → search 'uiserviced'"
    echo "     Send both when asking for help."
    echo ""
}

echo "==> Closing any running instance of Ofradr..."
pkill -x "$PROCESS_NAME" 2>/dev/null || true
pkill -x "$APP_NAME" 2>/dev/null || true
sleep 1

if reset_previous_hope_permissions; then
    HAD_PREVIOUS_INSTALL=1
fi

echo "==> Downloading Ofradr..."
curl -fL --progress-bar "$ZIP_URL" -o "$TMP_DIR/$APP_NAME.zip" || {
    echo "❌ Download failed. Check your connection and try again."
    exit 1
}

echo "==> Installing to $INSTALL_DIR..."
rm -rf "$TMP_DIR/extract"
ditto -x -k "$TMP_DIR/$APP_NAME.zip" "$TMP_DIR/extract" || {
    echo "❌ Could not extract the download."
    exit 1
}
if [ ! -d "$TMP_DIR/extract/$APP_NAME.app" ]; then
    echo "❌ Downloaded archive is missing $APP_NAME.app"
    exit 1
fi

if [ ! -w "$INSTALL_DIR" ] && [ ! -w "$(dirname "$INSTALL_DIR")" ]; then
    INSTALL_DIR="$HOME/Applications"
    echo "    /Applications not writable, using ~/Applications instead."
fi
mkdir -p "$INSTALL_DIR"
rm -rf "$INSTALL_DIR/$APP_NAME.app"
# ditto (not cp -R) preserves the code signature seal of the .app bundle.
ditto "$TMP_DIR/extract/$APP_NAME.app" "$INSTALL_DIR/$APP_NAME.app" || {
    echo "❌ Could not copy $APP_NAME.app to $INSTALL_DIR."
    exit 1
}

echo "==> Removing Gatekeeper quarantine..."
xattr -dr com.apple.quarantine "$INSTALL_DIR/$APP_NAME.app" 2>/dev/null || true

if [ -x "$LSREGISTER" ]; then
    "$LSREGISTER" -f "$INSTALL_DIR/$APP_NAME.app" >/dev/null 2>&1 || true
fi

echo "==> Launching Ofradr..."
if ! open "$INSTALL_DIR/$APP_NAME.app" 2>/dev/null; then
    echo "❌ macOS refused to open $INSTALL_DIR/$APP_NAME.app."
    print_launch_failure_help
    exit 1
fi

# `open` returns before the process exists (and returns 0 even when the app
# later refuses to launch), so wait for the real process before claiming success.
LAUNCHED=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
    if pgrep -x "$PROCESS_NAME" >/dev/null 2>&1; then
        LAUNCHED=1
        break
    fi
    sleep 1
done

if [ "$LAUNCHED" -ne 1 ]; then
    echo "❌ Ofradr did not start within 10 seconds."
    print_launch_failure_help
    exit 1
fi

if [ "$HAD_PREVIOUS_INSTALL" -eq 1 ]; then
    echo "==> Re-requesting Screen Recording for this release..."
    sleep 1
    open_screen_recording_settings
fi

echo ""
echo "  ✅ Ofradr is installed and running!"
echo ""
echo "  Log file: $LOG_PATH"
if [ "$HAD_PREVIOUS_INSTALL" -eq 1 ]; then
    echo "  Previous Hope permissions were cleared for this update."
    echo "  Enable hope in Screen Recording if the toggle is off"
    echo "  (System Settings → Privacy & Security → Screen Recording)."
else
    echo "  First launch: allow Screen Recording when macOS asks"
    echo "  (System Settings → Privacy & Security → Screen Recording)."
fi
echo ""
