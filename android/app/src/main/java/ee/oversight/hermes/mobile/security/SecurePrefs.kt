package ee.oversight.hermes.mobile.security

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.util.Log
import androidx.core.os.UserManagerCompat
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.File
import java.security.GeneralSecurityException
import java.security.KeyStoreException

/**
 * Encrypted store for the 4 user secrets (server_key, provider_key,
 * tg_token, discord_token). Backed by EncryptedSharedPreferences
 * (AES256_SIV key wrap + AES256_GCM values, key in Android Keystore).
 *
 * First access migrates any existing cleartext values out of the
 * "hermes_mobile" prefs file into the encrypted file, then removes the
 * cleartext copies. Fail-closed on crypto failure: secrets are NEVER written
 * unencrypted (a failed write is logged and recorded for the UI via
 * lastError()), an encrypted read failure returns the default instead of
 * silently serving a cleartext copy, and while the store is in full fallback
 * (Keystore unavailable, isFallback() == true) putString() REFUSES every
 * secret so nothing is ever persisted in the clear. Non-secret keys keep
 * writing normally. Callers check isFallback()/lastError() to warn the user,
 * and HermesGatewayPlugin reports both through status()/startupInfo().
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
  // Inverted allowlist for fallback mode: putString refuses everything except
  // these. Empty today, no caller stores non-secrets through this object.
  val NON_SECRET_KEYS: Set<String> = emptySet()

  /**
   * Stable token for "the encrypted store is unavailable and a secret write
   * was refused". Every fallback refusal message starts with it, so the web
   * failure mapper can recognise the condition without parsing prose.
   */
  const val FALLBACK_ERROR = "secure_store_fallback"

  @Volatile private var cache: SharedPreferences? = null
  @Volatile private var fallback = false
  @Volatile private var lastError: String? = null

  /** True when encryption was unavailable and plain prefs are in use. */
  fun isFallback(): Boolean = fallback

  /** Human-readable reason for the last failed secret read/write, if any. */
  fun lastError(): String? = lastError

  /** Clears the sticky failure notice (e.g. after the user re-saves keys). */
  fun clearError() { lastError = null }

  private fun isCryptoCorruption(e: Throwable): Boolean {
    val msg = e.message.orEmpty()
    return e is GeneralSecurityException ||
      e is KeyStoreException ||
      msg.contains("AEADBadTagException", ignoreCase = true) ||
      msg.contains("KeyStore", ignoreCase = true) ||
      msg.contains("MasterKey", ignoreCase = true) ||
      msg.contains("could not read", ignoreCase = true)
  }

  private fun createEncryptedPrefs(app: Context): SharedPreferences? {
    return try {
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
      Log.w(TAG, "EncryptedSharedPreferences creation failed", e)
      if (isCryptoCorruption(e)) {
        Log.e(TAG, "Crypto corruption detected, attempting recovery by resetting encrypted store", e)
        recoverEncryptedPrefs(app)
      } else {
        null
      }
    }
  }

  private fun recoverEncryptedPrefs(app: Context): SharedPreferences? {
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        app.deleteSharedPreferences(ENC_NAME)
      } else {
        File(app.filesDir.parentFile, "shared_prefs/$ENC_NAME.xml").delete()
      }
      // The prefs file was not the only casualty: a corrupted MasterKey in
      // the AndroidKeyStore fails the rebuild with the same exception, which
      // used to send recovery into a permanent null loop (F07). Drop the key
      // entry first so the builder below mints a fresh one.
      try {
        val ks = java.security.KeyStore.getInstance("AndroidKeyStore")
        ks.load(null)
        ks.deleteEntry("_androidx_security_master_key_")
      } catch (e: Exception) {
        Log.w(TAG, "MasterKey entry eviction failed (continuing anyway)", e)
      }
      val masterKey = MasterKey.Builder(app)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()
      val enc = EncryptedSharedPreferences.create(
        app,
        ENC_NAME,
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
      )
      Log.i(TAG, "Recovered fresh EncryptedSharedPreferences after crypto corruption")
      enc
    } catch (e: Exception) {
      Log.e(TAG, "Recovery from crypto corruption failed", e)
      null
    }
  }

  @Synchronized
  fun prefs(ctx: Context): SharedPreferences {
    cache?.let { return it }
    val app = ctx.applicationContext

    // Direct Boot check: if user credential storage is not yet unlocked,
    // Android Keystore cannot be accessed. Do not poison cache or set permanent fallback.
    if (!UserManagerCompat.isUserUnlocked(app)) {
      Log.w(TAG, "Device locked (Direct Boot); returning plain prefs without caching fallback")
      return app.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    val enc = createEncryptedPrefs(app)
    if (enc != null) {
      fallback = false
      lastError = null
      migrateIfNeeded(app, enc)
      cache = enc
      return enc
    }

    Log.w(TAG, "EncryptedSharedPreferences unavailable while unlocked, falling back to cleartext prefs")
    fallback = true
    return app.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
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
        if (isCryptoCorruption(e)) {
          synchronized(this) {
            cache = null
          }
        }
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

  fun putString(ctx: Context, key: String, value: String): Boolean {
    try {
      // prefs() first: it is what flips fallback, so checking the flag before
      // the store exists would let the very first write land in cleartext.
      val store = prefs(ctx)
      // Fail closed: on fallback the plain file IS the store, so every key
      // written here must be treated as a secret. The allowlist is inverted
      // from the old shape (refuse listed secrets): now EVERYTHING refuses
      // and only known non-secret keys pass. Today there are none, every
      // caller stores credentials, so any write on fallback refuses loudly
      // instead of landing a provider key or token in cleartext.
      if (fallback && key !in NON_SECRET_KEYS) {
        // Fail closed (P0): the plain file must never receive a secret, and it
        // must never happen silently. Recording the refusal makes the caller
        // (setProvider/setServerKey/secretSet/renderConfig) reject with this
        // token and status()/startupInfo() surface it, instead of reporting
        // a save that quietly stored the secret unencrypted.
        val msg = "$FALLBACK_ERROR: secure storage is unavailable on this device, $key was not saved"
        Log.w(TAG, msg)
        lastError = msg
        return false
      }
      val ok = store.edit().putString(key, value).commit()
      if (!ok) {
        val msg = "failed to commit secret write to disk for $key"
        Log.w(TAG, msg)
        lastError = msg
        return false
      }
      lastError = null
      return true
    } catch (e: Exception) {
      // Fail closed: a secret is NEVER written unencrypted. Log, record for
      // the UI (isFallback()/lastError()), and keep the previous value.
      val msg = "encrypted secret write failed for $key, refusing cleartext write"
      Log.w(TAG, msg, e)
      lastError = msg
      if (isCryptoCorruption(e)) {
        synchronized(this) {
          cache = null
        }
      }
      return false
    }
  }

  fun remove(ctx: Context, key: String): Boolean {
    return try {
      prefs(ctx).edit().remove(key).commit()
    } catch (_: Exception) {
      false
    }
  }
}
