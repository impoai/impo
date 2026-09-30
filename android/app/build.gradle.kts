import java.util.Properties
import java.net.URI
import java.security.KeyStore
import java.security.MessageDigest

plugins {
    id("com.android.application")
    kotlin("android")
    kotlin("plugin.serialization")
    id("org.jetbrains.kotlin.plugin.compose")
}
val local = Properties().apply { rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) } }
fun config(name: String) = providers.gradleProperty(name).orNull ?: local.getProperty(name, "")
fun quoted(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
val releaseApiUrl = config("impo.release.apiUrl").ifBlank { config("impo.apiUrl") }
val releaseClerkKey = config("impo.release.clerkKey").ifBlank { config("impo.clerkKey") }
val signingFile = rootProject.file(config("impo.signingProperties").ifBlank { "../.local/android/release/signing.properties" })
val signing = Properties().apply { if (signingFile.exists()) signingFile.inputStream().use { load(it) } }
val releaseVersionCode = config("impo.versionCode").ifBlank { "1" }.toInt()
val releaseVersionName = config("impo.versionName").ifBlank { "0.1.0" }
android {
    namespace = "ai.impo"
    compileSdk = 36
    defaultConfig {
        applicationId = "ai.impo.android"
        minSdk = 28
        targetSdk = 36
        versionCode = releaseVersionCode
        versionName = releaseVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "API_BASE_URL", quoted(config("impo.apiUrl")))
        buildConfigField("String", "CLERK_PUBLISHABLE_KEY", quoted(config("impo.clerkKey")))
    }
    signingConfigs {
        create("release") {
            signing.getProperty("storeFile")?.let { storeFile = rootProject.file(it) }
            storePassword = signing.getProperty("storePassword")
            keyAlias = signing.getProperty("keyAlias")
            keyPassword = signing.getProperty("keyPassword")
            storeType = "PKCS12"
        }
    }
    buildTypes {
        debug { applicationIdSuffix = ".debug" }
        release {
            isDebuggable = false
            isMinifyEnabled = true
            signingConfig = signingConfigs.getByName("release")
            buildConfigField("String", "API_BASE_URL", quoted(releaseApiUrl))
            buildConfigField("String", "CLERK_PUBLISHABLE_KEY", quoted(releaseClerkKey))
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    buildFeatures { compose = true; buildConfig = true }
    packaging { resources.excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1", "META-INF/LICENSE.md", "META-INF/LICENSE-notice.md") }
    testOptions { unitTests.isReturnDefaultValues = true }
}
val validateReleaseConfiguration = tasks.register("validateReleaseConfiguration") {
    doLast {
        val endpoint = runCatching { URI(releaseApiUrl) }.getOrNull()
        check(endpoint?.scheme == "https" && !endpoint.host.isNullOrBlank() && endpoint.userInfo == null && endpoint.query == null && endpoint.fragment == null &&
            endpoint.host !in setOf("localhost", "127.0.0.1", "10.0.2.2") && !endpoint.host.endsWith(".invalid") && !endpoint.host.endsWith(".example")) {
            "Release requires a public HTTPS impo.release.apiUrl (or impo.apiUrl)."
        }
        check(releaseClerkKey.startsWith("pk_live_") && releaseClerkKey.length > 16) { "Release requires a live Clerk publishable key in impo.release.clerkKey (or impo.clerkKey)." }
        check(releaseVersionCode > 0 && releaseVersionCode <= 2_100_000_000 && releaseVersionName.isNotBlank()) { "Release version code/name must be valid and increase for each publication." }
        check(signingFile.isFile) { "Missing private signing properties. Run npm run android:signing:init once; never replace an existing release key." }
        listOf("storeFile", "storePassword", "keyAlias", "keyPassword", "certificateSha256").forEach { name ->
            check(!signing.getProperty(name).isNullOrBlank()) { "Missing $name in private signing properties." }
        }
        val keyFile = rootProject.file(signing.getProperty("storeFile"))
        check(keyFile.isFile) { "Release keystore is missing. Restore the original signing key; do not generate a replacement." }
        val keys = KeyStore.getInstance("PKCS12").apply { keyFile.inputStream().use { load(it, signing.getProperty("storePassword").toCharArray()) } }
        check(keys.isKeyEntry(signing.getProperty("keyAlias"))) { "Release signing alias does not contain a private key." }
        val certificate = keys.getCertificate(signing.getProperty("keyAlias"))
        val fingerprint = MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") { "%02x".format(it) }
        check(fingerprint.equals(signing.getProperty("certificateSha256").replace(":", ""), ignoreCase = true)) { "Signing certificate changed. Restore the original release key." }
    }
}
tasks.matching { it.name == "preReleaseBuild" }.configureEach { dependsOn(validateReleaseConfiguration) }
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
dependencies {
    implementation(project(":client"))
    implementation(platform("androidx.compose:compose-bom:2026.02.00"))
    implementation("androidx.activity:activity-compose:1.12.4")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended:1.7.8")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.browser:browser:1.9.0")
    implementation("androidx.navigation:navigation-compose:2.9.7")
    implementation("androidx.datastore:datastore-preferences:1.2.0")
    implementation("androidx.work:work-runtime-ktx:2.11.0")
    implementation("androidx.health.connect:connect-client:1.1.0")
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.24.2")
    implementation("com.clerk:clerk-android-api:1.0.1")
    implementation("io.noties.markwon:core:4.6.2")
    implementation("io.noties.markwon:ext-tables:4.6.2")
    implementation("io.noties.markwon:ext-strikethrough:4.6.2")
    implementation("io.noties.markwon:ext-latex:4.6.2")
    implementation("io.noties.markwon:inline-parser:4.6.2")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.02.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
