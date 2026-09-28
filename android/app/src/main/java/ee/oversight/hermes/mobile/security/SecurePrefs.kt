package ee.oversight.hermes.mobile.security

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Encrypted store for the 4 user secrets (server_key, provider_key,
 * tg_token, discord_token). Backed by EncryptedSharedPreferences
 * (AES256_SIV key wrap + AES256_GCM values, key in Android Keystore).
 *
 * First access migrates any existing cleartext values out of the
 * "hermes_mobile" prefs file into the encrypted file, then removes the
 * cleartext copies. Fail-closed on crypto failure: secrets are NEVER written
 * unencrypted (a failed write is logged and recorded for the UI via
 * lastError()), and an encrypted read failure returns the default instead of
 * silently serving a cleartext copy. Callers check isFallback()/lastError()
 * to warn the user that secrets are not safely stored.
 */
object SecurePrefs {
  private const val TAG = "SecurePrefs"
  const val PREFS_NAME = "hermes_mobile"
  private const val ENC_NAME = "hermes_mobile_secrets"
  private const val MIGRATED_FLAG = "secrets_migrated_v1"

  const val KEY_SERVER = "server_key"
  const val KEY_PROVIDER = "provider_key"
  const val KEY_TG = "tg_token"
  const val KEY_DISCORD = "discord_token"

  val SECRET_KEYS: Set<String> = setOf(KEY_SERVER, KEY_PROVIDER, KEY_TG, KEY_DISCORD)

  @Volatile private var cache: SharedPreferences? = null
  @Volatile private var fallback = false
  @Volatile private var lastError: String? = null

  /** True when encryption was unavailable and plain prefs are in use. */
  fun isFallback(): Boolean = fallback

  /** Human-readable reason for the last failed secret read/write, if any. */
  fun lastError(): String? = lastError

  /** Clears the sticky failure notice (e.g. after the user re-saves keys). */
  fun clearError() { lastError = null }

  @Synchronized
  fun prefs(ctx: Context): SharedPreferences {
    cache?.let { return it }
    val app = ctx.applicationContext
    val enc = try {
      val masterKey = MasterKey.Builder(app)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()
      EncryptedSharedPreferences.create(
        app,
        ENC_NAME,
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
      )
    } catch (e: Exception) {
      Log.w(TAG, "EncryptedSharedPreferences unavailable, falling back to cleartext prefs", e)
      fallback = true
      null
    }
    val result = if (enc != null) {
      migrateIfNeeded(app, enc)
      enc
    } else {
      app.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }
    cache = result
    return result
  }

  private fun migrateIfNeeded(app: Context, enc: SharedPreferences) {
    val plain = app.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    try {
      if (!enc.getBoolean(MIGRATED_FLAG, false)) {
        val ed = enc.edit()
        for (k in SECRET_KEYS) {
          if (!enc.contains(k)) {
            val v = try { plain.getString(k, null) } catch (_: Exception) { null }
            if (!v.isNullOrEmpty()) ed.putString(k, v)
          }
        }
        ed.putBoolean(MIGRATED_FLAG, true)
        try { ed.apply() } catch (_: Exception) { }
        Log.i(TAG, "migrated secrets to encrypted store")
      }
    } catch (e: Exception) {
      Log.w(TAG, "secret migration failed, continuing without migration", e)
    } finally {
      // Always scrub cleartext copies while the encrypted store is open, even
      // when the flag was already set: a copy planted while Keystore was down
      // must not linger unforgotten in the plain file.
      try {
        val pe = plain.edit()
        for (k in SECRET_KEYS) pe.remove(k)
        pe.apply()
      } catch (_: Exception) { }
    }
  }

  fun getString(ctx: Context, key: String, default: String = ""): String {
    return try {
      prefs(ctx).getString(key, default) ?: default
    } catch (e: Exception) {
      // Fail closed: when the encrypted store itself errored, never silently
      // serve a cleartext copy (post-migration the plain file holds no
      // secrets anyway). Full-fallback mode is the only exception: there the
      // plain file IS the store because encryption is unavailable, and the UI
      // warns via isFallback().
      if (!fallback) {
        val msg = "encrypted secret read failed for $key, refusing cleartext fallback"
        Log.w(TAG, msg, e)
        lastError = msg
        return default
      }
      Log.w(TAG, "secret read failed for $key in fallback mode", e)
      try {
        ctx.applicationContext
          .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
          .getString(key, default) ?: default
      } catch (_: Exception) { default }
    }
  }

  fun putString(ctx: Context, key: String, value: String) {
    try {
      prefs(ctx).edit().putString(key, value).apply()
    } catch (e: Exception) {
      // Fail closed: a secret is NEVER written unencrypted. Log, record for
      // the UI (isFallback()/lastError()), and keep the previous value.
      val msg = "encrypted secret write failed for $key, refusing cleartext write"
      Log.w(TAG, msg, e)
      lastError = msg
    }
  }

  fun remove(ctx: Context, key: String) {
    try { prefs(ctx).edit().remove(key).apply() } catch (_: Exception) { }
  }
}
