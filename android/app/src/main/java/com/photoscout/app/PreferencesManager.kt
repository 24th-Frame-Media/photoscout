package com.photoscout.app

import android.content.Context
import android.content.SharedPreferences

class PreferencesManager(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("photoscout_prefs", Context.MODE_PRIVATE)

    var serverUrl: String
        get() {
            val saved = prefs.getString(KEY_SERVER_URL, "") ?: ""
            if (saved.isNotEmpty()) return saved
            return BuildConfig.DEFAULT_SERVER_URL
        }
        set(value) {
            prefs.edit().putString(KEY_SERVER_URL, value.trim().trimEnd('/')).apply()
        }

    var isBackgroundTrackingEnabled: Boolean
        get() = prefs.getBoolean(KEY_BG_TRACKING, false)
        set(value) = prefs.edit().putBoolean(KEY_BG_TRACKING, value).apply()

    fun clearServerUrl() {
        prefs.edit().remove(KEY_SERVER_URL).apply()
    }

    companion object {
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_BG_TRACKING = "bg_tracking"
    }
}
