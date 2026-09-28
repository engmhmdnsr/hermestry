plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.compose)
}

android {
  namespace = "ee.oversight.hermes.mobile"
  compileSdk = 36

  defaultConfig {
    applicationId = "ee.oversight.hermes.mobile"
    minSdk = 26
    targetSdk = 36
    versionCode = 23
    versionName = "1.3.0"
    
    ndk {
      // arm64-v8a only: the prebuilt hermes-image (with /opt/python314) is
      // aarch64-only, so no other ABI can actually start the gateway.
      abiFilters += listOf("arm64-v8a")
    }
  }

  // Belt and suspenders with extractNativeLibs="true": unpack .so files at
  // install time so the bundled proot binary really lands in nativeLibraryDir.

  signingConfigs {
    create("debugConfig") {
      storeFile = file("${rootDir}/debug.keystore")
      storePassword = "android"
      keyAlias = "androiddebugkey"
      keyPassword = "android"
    }
    create("releaseConfig") {
      storeFile = file("${rootDir}/hermes-mobile-release.keystore")
      storePassword = (project.findProperty("hermesReleaseStorePassword") as String?)
        ?.ifBlank { throw GradleException("hermesReleaseStorePassword is blank") }
        ?: throw GradleException("missing hermesReleaseStorePassword in gradle.properties (see README)")
      keyAlias = "hermes-mobile"
      keyPassword = (project.findProperty("hermesReleaseKeyPassword") as String?)
        ?.ifBlank { throw GradleException("hermesReleaseKeyPassword is blank") }
        ?: throw GradleException("missing hermesReleaseKeyPassword in gradle.properties (see README)")
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      signingConfig = signingConfigs.getByName("releaseConfig")
    }
    debug {
      signingConfig = signingConfigs.getByName("debugConfig")
    }
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
  }
  buildFeatures {
    compose = true
    buildConfig = true
  }
  packaging {
    jniLibs {
      useLegacyPackaging = true
    }
  }
}

dependencies {
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.lifecycle.viewmodel.compose)
  implementation(libs.androidx.activity.compose)
  implementation(platform(libs.androidx.compose.bom))
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.ui.graphics)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.androidx.compose.material3)
  implementation(libs.androidx.compose.material.icons.core)
  implementation(libs.androidx.compose.material.icons.extended)
  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.kotlinx.coroutines.core)
  implementation(libs.okhttp)
  implementation(libs.androidx.security.crypto)
  implementation(libs.androidx.work.runtime)
  implementation("org.apache.commons:commons-compress:1.26.1")
  implementation("org.tukaani:xz:1.10")
  debugImplementation(libs.androidx.compose.ui.tooling)
}
