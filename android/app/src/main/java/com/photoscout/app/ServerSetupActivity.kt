package com.photoscout.app

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import com.photoscout.app.databinding.ActivityServerSetupBinding
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class ServerSetupActivity : AppCompatActivity() {

    private lateinit var binding: ActivityServerSetupBinding
    private lateinit var preferencesManager: PreferencesManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityServerSetupBinding.inflate(layoutInflater)
        setContentView(binding.root)

        preferencesManager = PreferencesManager(this)

        val currentUrl = preferencesManager.serverUrl
        if (currentUrl.isNotEmpty()) {
            binding.urlEditText.setText(currentUrl)
        }

        binding.testButton.setOnClickListener {
            testConnection()
        }

        binding.connectButton.setOnClickListener {
            connectServer()
        }
    }

    private fun normalizeUrl(raw: String): String {
        var url = raw.trim()
        if (url.isEmpty()) return ""
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "https://$url"
        }
        return url.trimEnd('/')
    }

    private fun testConnection() {
        val targetUrl = normalizeUrl(binding.urlEditText.text?.toString() ?: "")
        if (targetUrl.isEmpty()) {
            binding.urlInputLayout.error = "Please enter a server URL"
            return
        }
        binding.urlInputLayout.error = null

        binding.testingProgress.visibility = View.VISIBLE
        binding.statusText.visibility = View.GONE
        binding.testButton.isEnabled = false
        binding.connectButton.isEnabled = false

        thread {
            var success = false
            var message = ""
            try {
                val endpoint = URL("$targetUrl/api/version")
                val conn = endpoint.openConnection() as HttpURLConnection
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                conn.requestMethod = "GET"
                conn.setRequestProperty("Accept", "application/json")
                conn.setRequestProperty("User-Agent", "PhotoScoutAndroid/${BuildConfig.VERSION_NAME}")

                val code = conn.responseCode
                if (code in 200..299) {
                    val responseText = conn.inputStream.bufferedReader().use { it.readText() }
                    val json = JSONObject(responseText)
                    val version = json.optString("display", json.optString("version", "ready"))
                    success = true
                    message = "PhotoScout server reached (v$version)"
                } else {
                    message = "Server responded with HTTP $code"
                }
            } catch (e: Exception) {
                message = "Connection failed: ${e.localizedMessage ?: e.javaClass.simpleName}"
            }

            runOnUiThread {
                binding.testingProgress.visibility = View.GONE
                binding.testButton.isEnabled = true
                binding.connectButton.isEnabled = true
                binding.statusText.visibility = View.VISIBLE
                binding.statusText.text = message
                if (success) {
                    binding.statusText.setTextColor(getColor(R.color.ps_success))
                } else {
                    binding.statusText.setTextColor(getColor(R.color.ps_error))
                }
            }
        }
    }

    private fun connectServer() {
        val targetUrl = normalizeUrl(binding.urlEditText.text?.toString() ?: "")
        if (targetUrl.isEmpty()) {
            binding.urlInputLayout.error = "Please enter a server URL"
            return
        }

        preferencesManager.serverUrl = targetUrl
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        }
        startActivity(intent)
        finish()
    }
}
