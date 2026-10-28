package com.photoscout.app

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.webkit.JavascriptInterface

class PhotoScoutBridge(
    private val activity: MainActivity,
    private val preferencesManager: PreferencesManager
) {
    @JavascriptInterface
    fun isNativeApp(): Boolean = true

    @JavascriptInterface
    fun getPlatform(): String = "android"

    @JavascriptInterface
    fun getAppVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun getServerUrl(): String = preferencesManager.serverUrl

    @JavascriptInterface
    fun openServerSettings() {
        activity.runOnUiThread {
            activity.openServerSettings()
        }
    }

    @JavascriptInterface
    fun setKeepAwake(enable: Boolean) {
        activity.runOnUiThread {
            activity.setKeepScreenAwake(enable)
        }
    }

    @JavascriptInterface
    fun startBackgroundLocation() {
        activity.runOnUiThread {
            activity.startLocationService()
        }
    }

    @JavascriptInterface
    fun stopBackgroundLocation() {
        activity.runOnUiThread {
            activity.stopLocationService()
        }
    }

    @JavascriptInterface
    fun isBackgroundTracking(): Boolean = LocationTrackingService.isRunning

    @JavascriptInterface
    fun vibrate(durationMs: Long) {
        activity.runOnUiThread {
            val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vibratorManager = activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                vibratorManager?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator?.vibrate(VibrationEffect.createOneShot(durationMs.coerceIn(10, 1000), VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                vibrator?.vibrate(durationMs.coerceIn(10, 1000))
            }
        }
    }
}
