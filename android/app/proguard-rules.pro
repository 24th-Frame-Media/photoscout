# PhotoScout Proguard Rules
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.photoscout.app.PhotoScoutBridge { *; }
