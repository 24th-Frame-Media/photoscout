# PhotoScout Mobile Apps (Android & iOS)

PhotoScout provides native mobile companion apps for both **Android** and **iOS**. They wrap the PhotoScout web interface with native device hardware acceleration and capabilities:

- **True background GPS tracking**: Fixes the web browser limitation documented in [convoy-mobile.md](convoy-mobile.md). An Android Foreground Service and iOS CoreLocation background entitlement maintain location updates during Convoy and Drive modes even when your screen is locked or you switch to other apps.
- **Screen Wake Lock**: Prevents screen sleep while navigating or following a convoy.
- **Camera & Photo upload**: Capture and upload photos directly to spots and places.
- **File Downloads & Sharing**: Native download manager and share sheet for exported GPX, GeoJSON, and zip archives.
- **Self-hosted Server Selector**: Connects to any PhotoScout instance (e.g. `https://scout.example.com` or local LAN `http://192.168.1.x:3003`), validates with `/api/version`, remembers your server, and allows switching instances anytime.

---

## 1. Android App (No Store Required)

The Android app is distributed directly as an APK without going through the Google Play Store.

### Installing the APK

1. **Download the APK**:
   - Download directly from [**GitHub Releases (Latest)**](https://github.com/kapsikkum/photoscout/releases/latest):
     - [**`PhotoScout-release.apk`**](https://github.com/kapsikkum/photoscout/releases/latest/download/PhotoScout-release.apk) (Ready for immediate install on any Android 8.0+ device)
     - `PhotoScout-debug.apk` (For testing and ADB logcat debugging)
   - Or download from the **Actions** tab -> latest **mobile** run -> **PhotoScout-Android-APKs**.
2. **Install on Phone**:
   - Transfer or download the `.apk` file to your Android phone.
   - Tap the `.apk` file to install.
   - If prompted with *"For your security, your phone is not allowed to install unknown apps from this source"*, tap **Settings** and toggle **Allow from this source**.
   - Tap **Install**.
3. **First Launch**:
   - Open PhotoScout.
   - Enter your server address (e.g., `https://photoscout.yourdomain.com`).
   - Tap **Test Connection** to verify `/api/version`.
   - Tap **Connect**.
4. **Permissions**:
   - When prompted, grant **Location** permission (*"While using the app"* or *"All the time"*).
   - Grant **Notification** permission so the Convoy background service can display its persistent status notification while driving.

### Building Android Locally

Prerequisites: JDK 17 or 21, Android SDK.

```bash
cd android
./gradlew assembleDebug      # Linux/macOS
gradlew.bat assembleDebug   # Windows
```

The APK will be at `android/app/build/outputs/apk/debug/app-debug.apk`.

To install directly to a connected Android phone or emulator:
```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

---

## 2. iOS App (Without a Paid Developer Account)

Apple requires a \$99/year developer membership **only** to publish on the App Store or public TestFlight. You **do not** need to pay \$99 to install and use PhotoScout on your iPhone or share it with friends.

The GitHub Actions workflow automatically builds an unsigned IPA ([`PhotoScout-unsigned.ipa`](https://github.com/kapsikkum/photoscout/releases/latest/download/PhotoScout-unsigned.ipa)) and application bundle on a macOS runner, published directly to [**GitHub Releases**](https://github.com/kapsikkum/photoscout/releases/latest).

### Sideloading Options ($0 Cost)

#### Option A: AltStore / SideStore (Recommended)
AltStore and SideStore use your free Apple ID to sign and install apps directly onto your iPhone. They can automatically refresh the 7-day personal certificate over Wi-Fi in the background.

1. Download and install **AltServer** on your computer (Windows or Mac) from [altstore.io](https://altstore.io).
2. Connect your iPhone via USB, open AltServer, and choose **Install AltStore** -> select your phone.
3. Download [**`PhotoScout-unsigned.ipa`**](https://github.com/kapsikkum/photoscout/releases/latest/download/PhotoScout-unsigned.ipa) directly from [Releases](https://github.com/kapsikkum/photoscout/releases/latest) on your iPhone (e.g. via Safari).
4. In the Files app or Safari Downloads, tap **Share** -> **AltStore** (or open AltStore -> My Apps -> tap `+` and choose `PhotoScout-unsigned.ipa`). Or on PC, hold **Shift** and left-click the AltServer tray icon -> **Sideload .ipa...** -> pick `PhotoScout-unsigned.ipa`.
5. AltStore signs the IPA with your free Apple ID and installs PhotoScout to your home screen!

*(SideStore note: [sidestore.io](https://sidestore.io) is a fork of AltStore that refreshes apps using WireGuard VPN directly on your phone without needing a computer running AltServer).*

#### Option B: Sideloadly (Easiest from PC/Mac)
1. Download **Sideloadly** (Windows or Mac) from [sideloadly.io](https://sideloadly.io).
2. Connect your iPhone with a USB cable.
3. Drag `PhotoScout-unsigned.ipa` into the Sideloadly window.
4. Enter your Apple ID and click **Start**.
5. Sideloadly signs and installs the app onto your iPhone in seconds.

#### Option C: TrollStore (Permanent, No 7-Day Revokes)
If your iPhone runs an iOS version supported by TrollStore (iOS 14.0 – 16.6.1 or 17.0 depending on device model):
1. Open TrollStore on your iPhone.
2. Download `PhotoScout-unsigned.ipa` and open it with TrollStore.
3. It installs permanently with root entitlements and never expires!

#### Option D: Xcode Free Personal Team (If you or a friend have a Mac)
1. Clone this repository.
2. Open `ios/PhotoScout.xcodeproj` in Xcode.
3. Go to Xcode **Settings** > **Accounts** and add your free Apple ID.
4. In the Project Navigator, select **PhotoScout**, go to **Signing & Capabilities**, and select your **Personal Team**.
5. Select your connected iPhone from the device dropdown and click the **Run** (Play) button. Xcode will compile, sign, and launch PhotoScout on your iPhone.

---

## 3. GitHub Actions CI/CD (`mobile.yml`)

The repository includes a dedicated workflow at `.github/workflows/mobile.yml`.

### Triggers:
- **Git Tags**: Pushing any tag starting with `v*` (e.g. `v0.1.0`) triggers both Android and iOS builds, creates a GitHub Release, and attaches:
  - `PhotoScout-debug.apk`
  - `PhotoScout-release.apk`
  - `PhotoScout-unsigned.ipa`
- **Manual Trigger**: Open GitHub -> Actions -> **mobile** -> **Run workflow**. You can choose whether to build Android, iOS, or both, and optionally bake in a default server URL.
- **Automatic CI**: Runs when changes are pushed to `android/**`, `ios/**`, or `.github/workflows/mobile.yml`.

### Android Signing in Actions:
- If repository secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, etc.) are configured, Actions signs the release APK with your custom key.
- If secrets are **not** present, Actions automatically generates a self-signed release keystore on the fly and signs the release APK with `apksigner`. This ensures ready-to-install APKs are produced on every build without requiring manual keystore configuration.

### iOS Build in Actions:
- Uses GitHub's `macos-14` runner with Xcode.
- Builds the release binary with `CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO`.
- Packages the `PhotoScout.app` bundle into a clean `PhotoScout-unsigned.ipa` archive ready for sideloading tools.

---

## 4. Native JavaScript Bridge

Both the Android and iOS containers inject a `PhotoScoutNative` interface into the web environment:

```typescript
interface PhotoScoutNative {
  isNative: boolean;               // true in Android & iOS apps
  platform: 'android' | 'ios';     // Operating system
  version: string;                 // Native app version
  startBackgroundLocation(): void; // Starts foreground tracking service (Android) / CoreLocation background updates (iOS)
  stopBackgroundLocation(): void;  // Stops background location
  setKeepAwake(enable: boolean): void; // Keeps screen from dimming/sleeping
  openServerSettings(): void;      // Opens the native server configuration dialog
  vibrate(durationMs?: number): void;
}
```

The web app detects `window.PhotoScoutNative` automatically:
- When joining a Convoy or enabling location sharing, `startBackgroundLocation()` is triggered.
- When leaving or stopping sharing, `stopBackgroundLocation()` is called.
- When on the `/drive` or `/convoy` page, the native wake lock is engaged to keep the display active.
