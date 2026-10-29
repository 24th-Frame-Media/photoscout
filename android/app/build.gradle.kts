plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.photoscout.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.photoscout.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        val defaultServer = project.findProperty("photoscoutServerUrl") as? String ?: ""
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"$defaultServer\"")
    }

    buildFeatures {
        buildConfig = true
        viewBinding = true
    }

    signingConfigs {
        create("release") {
            val storeFilePath = System.getenv("ANDROID_KEYSTORE_PATH") ?: project.findProperty("androidKeystorePath") as? String
            val storePwd = System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: project.findProperty("androidKeystorePassword") as? String
            val keyAliasName = System.getenv("ANDROID_KEY_ALIAS") ?: project.findProperty("androidKeyAlias") as? String
            val keyPwd = System.getenv("ANDROID_KEY_PASSWORD") ?: project.findProperty("androidKeyPassword") as? String

            if (!storeFilePath.isNullOrEmpty() && file(storeFilePath).exists()) {
                storeFile = file(storeFilePath)
                storePassword = storePwd
                keyAlias = keyAliasName
                keyPassword = keyPwd
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            val releaseSigning = signingConfigs.getByName("release")
            if (releaseSigning.storeFile != null) {
                signingConfig = releaseSigning
            }
        }
        debug {
            applicationIdSuffix = ".debug"
            isDebuggable = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.webkit:webkit:1.12.0")
}
