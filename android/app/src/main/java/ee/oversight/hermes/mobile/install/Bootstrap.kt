package ee.oversight.hermes.mobile.install

import android.content.Context
import android.os.Build
import android.os.StatFs
import ee.oversight.hermes.mobile.normProvider
import ee.oversight.hermes.mobile.security.SecurePrefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.apache.commons.compress.archivers.ar.ArArchiveInputStream
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Real on-device installer, v1.
 * Downloads proot + Debian rootfs on first run (small APK), extracts,
 * installs hermes-agent via pip inside the rootfs, renders config.yaml.
 */
object Bootstrap {
  // Debian rootfs: AnLinux-Resources tarballs (verified 2026-09-26, bookworm,
  // resolv.conf + apt sources included). proot: Termux apt .deb (their
  // github repo ships no binaries) - binary + loader extracted from data.tar.xz.
  private const val ROOTFS_AARCH64 =
    "https://raw.githubusercontent.com/EXALAB/AnLinux-Resources/master/Rootfs/Debian/arm64/debian-rootfs-arm64.tar.xz"
  private const val ROOTFS_ARM =
    "https://raw.githubusercontent.com/EXALAB/AnLinux-Resources/master/Rootfs/Debian/armhf/debian-rootfs-armhf.tar.xz"
  private const val ROOTFS_X86_64 =
    "https://raw.githubusercontent.com/EXALAB/AnLinux-Resources/master/Rootfs/Debian/amd64/debian-rootfs-amd64.tar.xz"
  private const val PROOT_AARCH64 =
    "https://packages.termux.dev/apt/termux-main/pool/main/p/proot/proot_5.1.107.95_aarch64.deb"
  private const val PROOT_ARM =
    "https://packages.termux.dev/apt/termux-main/pool/main/p/proot/proot_5.1.107.95_arm.deb"
  private const val PROOT_X86_64 =
    "https://packages.termux.dev/apt/termux-main/pool/main/p/proot/proot_5.1.107.95_x86_64.deb"
  // proot is dynamically linked: needs libtalloc + libandroid-shmem from the
  // same repo (parsed from its ELF DT_NEEDED). Extracted next to it, wired
  // via LD_LIBRARY_PATH in runProot.
  private const val LIBTALLOC_AARCH64 =
    "https://packages.termux.dev/apt/termux-main/pool/main/libt/libtalloc/libtalloc_2.4.3_aarch64.deb"
  private const val LIBTALLOC_ARM =
    "https://packages.termux.dev/apt/termux-main/pool/main/libt/libtalloc/libtalloc_2.4.3_arm.deb"
  private const val LIBTALLOC_X86_64 =
    "https://packages.termux.dev/apt/termux-main/pool/main/libt/libtalloc/libtalloc_2.4.3_x86_64.deb"
  private const val SHMEM_AARCH64 =
    "https://packages.termux.dev/apt/termux-main/pool/main/liba/libandroid-shmem/libandroid-shmem_0.7_aarch64.deb"
  private const val SHMEM_ARM =
    "https://packages.termux.dev/apt/termux-main/pool/main/liba/libandroid-shmem/libandroid-shmem_0.7_arm.deb"
  private const val SHMEM_X86_64 =
    "https://packages.termux.dev/apt/termux-main/pool/main/liba/libandroid-shmem/libandroid-shmem_0.7_x86_64.deb"

  // SHA-256 pins of the exact files above (computed 2026-09-26 from the same URLs).
  // aarch64 only. Every download requires a pin (fail closed): arches without
  // a pin refuse to download instead of fetching unverified bytes. If upstream
  // rotates a file, install fails closed with the expected hash in the message.
  private const val ROOTFS_AARCH64_SHA =
    "b9f1fbc28cad7984d3a9bac86bf86895c388a3ea398261cc3f761145d5c366dc"
  private const val PROOT_AARCH64_SHA =
    "0a1b3d0f6ef76436c5ed924cd8e8f5a6b7186e99e1650eb2d9bc734e218a74cb"
  private const val LIBTALLOC_AARCH64_SHA =
    "ac81ad623d74c209718b9f3acb2dd702cc8a88c431e820d212229910b4db29da"
  private const val SHMEM_AARCH64_SHA =
    "0da3a24d558b93c92bcf8d611e0826a99ff96e396b148e6cdf33b47c47c57ff6"

  // One-shot prebuilt image (v2): Debian bookworm arm64 + Python 3.14 +
  // hermes-agent 0.21.5 baked once and published as a GitHub Release asset.
  // The phone downloads ONE file, verifies sha256 (fetched live so image
  // rotations need no app update), extracts, and runs. No apt/pip/DNS on
  // the device. aarch64 only; other arches keep the legacy multi-step path.
  private const val IMAGE_AARCH64_URL =
    "https://github.com/engmhmdnsr/HERMES-MOBILE/releases/download/v1.0.0-image/hermes-image.tar.gz"
  private const val IMAGE_AARCH64_SHA_URL =
    "https://github.com/engmhmdnsr/HERMES-MOBILE/releases/download/v1.0.0-image/hermes-image.tar.gz.sha256"
  // Pinned SHA-256 of the hermes-image.tar.gz release asset. Checked IN
  // ADDITION to the live .sha256 asset: fail CLOSED when they disagree so a
  // compromised mirror cannot move both files at once.
  private const val IMAGE_AARCH64_SHA =
    "ddb42c921918f2bc1b67ac08e9d62c2fe0f7e98b9e95c1ceb4e2815474e13c06"

  fun rootDir(app: Context): File = File(app.filesDir, "debian")
  fun rootfsDir(app: Context): File = File(rootDir(app), "rootfs")
  fun prootPkgDir(app: Context): File = File(rootDir(app), "proot-pkg")
  /**
   * proot lives INSIDE the APK (jniLibs -> nativeLibraryDir), not in files/.
   * Android 10+ SELinux on many devices denies execve from files/ (error=13)
   * while the native lib dir is always executable. The .deb download path
   * below stays as fallback for ABIs without a bundled binary.
   */
  fun bundledProot(app: Context): File =
    File(app.applicationInfo.nativeLibraryDir, "lib_proot.so")
  fun prootFile(app: Context): File {
    val b = bundledProot(app)
    if (b.exists()) return b
    return File(prootPkgDir(app), "bin/proot")
  }

  /**
   * Termux ships proot's static ELF loaders (libexec/proot/loader[/32]) as
   * separate ET_EXEC files precisely so PROOT_LOADER can point at them.
   * We bundle them as lib_proot_loader[.32].so: exec from the APK lib dir
   * is allowed, exec of proot's own temp extraction is not.
   */
  fun prootLoaderFile(app: Context): File? {
    val f = File(app.applicationInfo.nativeLibraryDir, "lib_proot_loader.so")
    return if (f.exists()) f else null
  }
  fun prootLoader32File(app: Context): File? {
    val f = File(app.applicationInfo.nativeLibraryDir, "lib_proot_loader32.so")
    return if (f.exists()) f else null
  }
  fun hermesHome(app: Context): File = File(rootDir(app), "hermes_home")

  /** proot's DT_NEEDED (libtalloc.so.2, libandroid-shmem.so) under the
   *  SONAMEs the loader wants. Read-only exec is fine from files/; only
   *  execve() itself was blocked, which is why proot moved to jniLibs. */
  fun stageBundledLibs(app: Context): Boolean {
    val dir = File(app.applicationInfo.nativeLibraryDir)
    val talloc = File(dir, "lib_talloc.so")
    val shmem = File(dir, "lib_shmem.so")
    if (!talloc.exists() || !shmem.exists()) return false
    val lib = File(prootPkgDir(app), "lib").apply { mkdirs() }
    talloc.copyTo(File(lib, "libtalloc.so.2"), overwrite = true)
    shmem.copyTo(File(lib, "libandroid-shmem.so"), overwrite = true)
    return true
  }

  fun isInstalled(app: Context): Boolean =
    File(rootDir(app), ".installed").exists() && prootFile(app).canExecute() &&
      File(prootPkgDir(app), "lib/libtalloc.so.2").exists() &&
      File(rootfsDir(app), ".rootfs_ok").exists()

  fun arch(): String {
    val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a"
    return when {
      abi.contains("arm64", true) || abi.contains("aarch64", true) -> "aarch64"
      abi.contains("x86_64", true) -> "x86_64"
      else -> "arm"
    }
  }

  fun rootfsUrl(): String = when (arch()) {
    "x86_64" -> ROOTFS_X86_64
    "arm" -> ROOTFS_ARM
    else -> ROOTFS_AARCH64
  }

  /** Same AnLinux file via the github.com mirror host (used once if raw 404s). */
  fun rootfsFallbackUrl(): String? =
    rootfsUrl().replace(
      "https://raw.githubusercontent.com/EXALAB/AnLinux-Resources/master/",
      "https://github.com/EXALAB/AnLinux-Resources/raw/refs/heads/master/"
    ).takeIf { it != rootfsUrl() }

  fun prootUrl(): String = when (arch()) {
    "x86_64" -> PROOT_X86_64
    "arm" -> PROOT_ARM
    else -> PROOT_AARCH64
  }

  /** proot .deb + its two library .debs: (url, label, aptPackage, sha256 pin).
   *  Non-aarch64 entries carry no pin (null): install() refuses to download
   *  them (fail closed) until pins are recorded here. Never null a pin at the
   *  call site to "allow" an unverified download. */
  fun debUrls(): List<DebSpec> = when (arch()) {
    "x86_64" -> listOf(
      DebSpec(PROOT_X86_64, "proot", "proot", null),
      DebSpec(LIBTALLOC_X86_64, "libtalloc", "libtalloc", null),
      DebSpec(SHMEM_X86_64, "libandroid-shmem", "libandroid-shmem", null)
    )
    "arm" -> listOf(
      DebSpec(PROOT_ARM, "proot", "proot", null),
      DebSpec(LIBTALLOC_ARM, "libtalloc", "libtalloc", null),
      DebSpec(SHMEM_ARM, "libandroid-shmem", "libandroid-shmem", null)
    )
    else -> listOf(
      DebSpec(PROOT_AARCH64, "proot", "proot", PROOT_AARCH64_SHA),
      DebSpec(LIBTALLOC_AARCH64, "libtalloc", "libtalloc", LIBTALLOC_AARCH64_SHA),
      DebSpec(SHMEM_AARCH64, "libandroid-shmem", "libandroid-shmem", SHMEM_AARCH64_SHA)
    )
  }

  data class DebSpec(val url: String, val label: String, val aptPackage: String, val sha256: String?)

  fun rootfsSha(): String? = if (arch() == "aarch64") ROOTFS_AARCH64_SHA else null

  // INSTALL-01: app/gateway/protocol compatibility metadata. The plugin
  // exposes this via preflight()/status() and the web UI gates Start on it.
  const val APP_VERSION = "1.3.0"
  const val GATEWAY_VERSION = "0.21.5"
  const val PROTOCOL_VERSION = 1
  const val IMAGE_VERSION = "v1.0.0-image"

  data class CompatInfo(
    val appVersion: String,
    val gatewayVersion: String,
    val protocolVersion: Int,
    val imageVersion: String,
    val compatible: Boolean,
    val error: String?
  )

  fun compatInfo(): CompatInfo = CompatInfo(
    appVersion = APP_VERSION,
    gatewayVersion = GATEWAY_VERSION,
    protocolVersion = PROTOCOL_VERSION,
    imageVersion = IMAGE_VERSION,
    compatible = true,
    error = null
  )

  /** True when the on-disk image marker matches the image this app runs. */
  fun isImageCompatible(app: Context): Boolean = try {
    val marker = File(rootfsDir(app), ".image_ok")
      .takeIf { it.exists() }?.readText()?.trim().orEmpty()
    marker == IMAGE_VERSION
  } catch (_: Exception) { false }

  // INSTALL-04: pre-install storage calculation. Archive (~305MB) + extracted
  // tree (~900MB) + config/logs margin: refuse early with numbers instead of
  // dying mid-extract with ENOSPC.
  const val IMAGE_ARCHIVE_BYTES = 305L * 1024L * 1024L
  const val IMAGE_EXTRACTED_BYTES = 900L * 1024L * 1024L
  fun requiredBytes(): Long = IMAGE_ARCHIVE_BYTES + IMAGE_EXTRACTED_BYTES

  data class StoragePreflight(
    val freeBytes: Long,
    val neededBytes: Long,
    val enough: Boolean
  ) {
    val freeMb: Long get() = freeBytes / (1024L * 1024L)
    val neededMb: Long get() = neededBytes / (1024L * 1024L)
  }

  fun storagePreflight(app: Context): StoragePreflight {
    val needed = requiredBytes()
    val free = try {
      StatFs(app.filesDir.absolutePath).availableBytes
    } catch (_: Exception) { -1L }
    // Fail CLOSED on unknown free space (StatFs -1): an unreadable stat must
    // warn and refuse, never silently assume room for a ~1.2GB install.
    return StoragePreflight(freeBytes = free, neededBytes = needed, enough = free >= needed)
  }

  fun requireStorage(app: Context, onStep: (String) -> Unit = {}) {
    val pre = storagePreflight(app)
    val freeLabel = if (pre.freeBytes < 0L) "unknown" else "${pre.freeMb}MB"
    onStep("storage: $freeLabel free, ${pre.neededMb}MB required")
    if (!pre.enough) throw RuntimeException(
      if (pre.freeBytes < 0L)
        "needs_space: free space unknown (stat failed), refusing install. Free space, then retry."
      else
        "needs_space: ${pre.freeMb}MB free, ${pre.neededMb}MB required. Free space, then retry."
    )
  }

  // INSTALL-03: real install progress phases. installPhaseForLine maps a raw
  // log line to its phase so the plugin can emit installPhase events; the web
  // UI (gatewayState.ts) mirrors the same mapping for fallback parsing.
  enum class InstallPhase {
    CHECK_STORAGE, DOWNLOAD, VERIFY, EXTRACT, CONFIGURE, DONE
  }

  fun installPhaseForLine(line: String): InstallPhase? {
    val t = line.lowercase()
    return when {
      "storage:" in t || "needs_space" in t || "no space left" in t -> InstallPhase.CHECK_STORAGE
      "downloading" in t -> InstallPhase.DOWNLOAD
      "checksum" in t || "verifying" in t -> InstallPhase.VERIFY
      "extracting" in t || "linking" in t || "clearing previous rootfs" in t -> InstallPhase.EXTRACT
      "writing gateway config" in t || "proot" in t || "dns fixed" in t ||
        "installing hermes-agent" in t || "debian rootfs ready" in t ||
        "prebuilt image ready" in t || "proot ready" in t -> InstallPhase.CONFIGURE
      line.trim() == "done" || "already installed" in t -> InstallPhase.DONE
      else -> null
    }
  }

  // INSTALL-02: image manifest preference. The manifest lists the current
  // image asset; when it carries entries, the entry carrying a non-blank
  // "signature" label wins. That label is a publisher preference marker only,
  // NOT cryptographic verification: no signature is checked here. Trust comes
  // from the sha256 pin (compiled pin vs live .sha256 cross-check in
  // installImage plus resolveImageAsset below). Null = manifest unreachable,
  // use pins.
  const val IMAGE_MANIFEST_URL =
    "https://github.com/engmhmdnsr/HERMES-MOBILE/releases/download/v1.0.0-image/hermes-image.manifest.json"

  data class ImageManifest(val url: String, val sha256: String, val signature: String)

  fun fetchImageManifest(): ImageManifest? {
    return try {
      val c = (URL(IMAGE_MANIFEST_URL).openConnection() as HttpURLConnection).apply {
        connectTimeout = 15_000; readTimeout = 30_000; instanceFollowRedirects = true
      }
      c.connect()
      if (c.responseCode !in 200..299) return null
      parseImageManifest(c.inputStream.bufferedReader().readText())
    } catch (_: Exception) { null }
  }

  /**
   * Picks the preferred entry from a manifest blob. Pure function, no network.
   * Shape: {"images":[{"url":...,"sha256":...,"signature":...}]}.
   * A non-blank "signature" is a publisher preference label only (preferred
   * entry wins); it is NOT cryptographically verified.
   */
  fun parseImageManifest(text: String): ImageManifest? {
    return try {
      val objs = Regex("\\{[^{}]*\"url\"[^{}]*\\}").findAll(text)
      var unlabeled: ImageManifest? = null
      for (m in objs) {
        val b = m.value
        fun field(name: String): String =
          Regex("\"" + name + "\"\\s*:\\s*\"([^\"]*)\"").find(b)?.groupValues?.get(1).orEmpty()
        val e = ImageManifest(field("url"), field("sha256"), field("signature"))
        if (e.url.isBlank() || e.sha256.isBlank()) continue
        if (e.signature.isNotBlank()) return e
        if (unlabeled == null) unlabeled = e
      }
      unlabeled
    } catch (_: Exception) { null }
  }

  /**
   * Resolves the image asset to download: the labeled manifest entry wins, but
   * its sha must still agree with the compiled pin (fail closed on rotation).
   * Returns (url, sha); falls back to the pins when unreachable.
   */
  fun resolveImageAsset(): Pair<String, String> {
    val m = fetchImageManifest()
    if (m != null) {
      if (!m.sha256.equals(IMAGE_AARCH64_SHA, ignoreCase = true)) throw ChecksumException(
        "image manifest sha ${m.sha256} disagrees with pinned build $IMAGE_AARCH64_SHA. " +
          "Upstream rotated the image, update the pin."
      )
      if (m.url.isNotBlank()) return Pair(m.url, IMAGE_AARCH64_SHA)
    }
    return Pair(IMAGE_AARCH64_URL, IMAGE_AARCH64_SHA)
  }

  suspend fun install(app: Context, onStep: (String) -> Unit) = withContext(Dispatchers.IO) {
    val root = rootDir(app)
    root.mkdirs()
    hermesHome(app).mkdirs()
    // INSTALL-04: refuse before any bytes move when storage is short.
    requireStorage(app, onStep)

    // SkipMarker: full success leaves .installed; partial installs redo only missing parts.
    if (isInstalled(app)) {
      onStep("already installed")
      return@withContext
    }

    // v2 one-shot (aarch64): single prebuilt image, no apt/pip on device.
    if (arch() == "aarch64") {
      installImage(app, onStep)
      return@withContext
    }
    onStep("note: prebuilt image is arm64-only, using legacy install (experimental support for ${arch()})")

    // 1. proot binary + libs. Preferred: bundled in the APK (exec-safe dir).
    // Fallback: Termux .debs into proot-pkg (fails with error=13 on devices
    // whose SELinux blocks exec from files/).
    val proot = prootFile(app)
    val pkg = prootPkgDir(app)
    onStep("proot: ${proot.absolutePath}")
    if (stageBundledLibs(app)) onStep("proot bundled in app, libs staged")
    // lib check covers upgrades from builds that installed proot without libs
    if (!proot.canExecute() || !File(pkg, "lib/libtalloc.so.2").exists()) {
      for (spec in debUrls()) {
        val deb = File(root, "${spec.label}.deb")
        try {
          onStep("downloading ${spec.label} (${arch()})...")
          val pin = spec.sha256
            ?: throw RuntimeException(
              "no SHA-256 pin for ${spec.label} on ${arch()} " +
                "(only aarch64 artifacts are pinned), refusing unverified download"
            )
          downloadTo(spec.url, deb, pin,
            { pct -> onStep("downloading ${spec.label}... $pct%") },
            { msg -> onStep("${spec.label}: $msg") },
            fallback = { resolveDebFromIndex(spec.aptPackage) })
          onStep("extracting ${spec.label}...")
          extractDeb(deb, pkg)
        } finally {
          deb.delete()
        }
      }
      proot.setExecutable(true)
    } else onStep("proot ready")

    // 2. rootfs (sentinel .rootfs_ok: the tar ships sh but NOT python3,
    // so file-existence checks alone can't prove a complete extraction)
    val fs = rootfsDir(app)
    if (!File(fs, ".rootfs_ok").exists()) {
      val tmp = File(root, "rootfs.tar.xz")
      try {
        onStep("downloading debian rootfs (~80MB)...")
        val sha = rootfsSha()
          ?: throw RuntimeException(
            "no SHA-256 pin for the debian rootfs on ${arch()} " +
              "(only aarch64 is pinned), refusing unverified download"
          )
        downloadTo(rootfsUrl(), tmp, sha,
          { pct -> onStep("downloading debian... $pct%") },
          { msg -> onStep("debian: $msg") },
          fallback = { rootfsFallbackUrl()?.let { FallbackTarget(it, sha) } })
        onStep("extracting debian (one time, slow)...")
        extractTarXz(tmp, fs, "",
          { n -> if (n % 2000 == 0) onStep("extracting... $n files") },
          { m -> onStep(m) })
        File(fs, ".rootfs_ok").writeText("bookworm ${arch()}")
        File(root, ".pip_ok").delete() // fresh rootfs needs its own pip install
      } finally {
        tmp.delete()
      }
    } else onStep("debian rootfs ready")
    // Always verify (even on sentinel hit): a half-extracted rootfs from an
    // older build fails later with proot's "interpreter not found".
    val bad = verifyRootfs(fs)
    if (bad.isEmpty()) {
      onStep("rootfs check: loader + libc OK")
    } else {
      bad.take(8).forEach { onStep("rootfs MISSING: $it") }
      // Force a clean re-extract + re-install next retry (stale sentinels off).
      File(fs, ".rootfs_ok").delete()
      File(root, ".pip_ok").delete()
      throw RuntimeException(
        "rootfs incomplete (${bad.size} gaps, see MISSING lines), retry re-downloads it"
      )
    }

    // 3. base packages + hermes-agent via pip inside proot
    // (Debian 12 pip needs --break-system-packages outside a venv.)
    if (!File(root, ".pip_ok").exists()) {
      onStep("installing hermes-agent (pip, one time)...")
      // AnLinux rootfs ships no working DNS: without this apt/pip fail with
      // "Temporary failure resolving ...". Host-side write, no proot needed.
      val resolv = File(fs, "etc/resolv.conf")
      try {
        resolv.parentFile?.mkdirs()
        if (!resolv.exists() || resolv.readText().contains("127.")) {
          resolv.writeText("nameserver 8.8.8.8\nnameserver 1.1.1.1\n")
          onStep("dns fixed (8.8.8.8)")
        }
      } catch (e: Exception) { onStep("dns write failed: ${e.message}") }
      val prep = runProot(
        app,
        "apt-get update && apt-get install -y python3 python3-pip && " +
          "python3 -m pip install --upgrade --break-system-packages pip && " +
          "python3 -m pip install --break-system-packages hermes-agent"
      )
      if (prep != 0) {
        // Surface the real cause on screen: last 12 lines of the proot log.
        try {
          File(rootDir(app), "bootstrap_last.log").readLines()
            .takeLast(12).forEach { onStep(it.take(160)) }
        } catch (_: Exception) { }
        throw RuntimeException("pip install failed (exit $prep), check network then retry")
      }
      File(root, ".pip_ok").writeText("hermes-agent")
    } else onStep("hermes-agent ready")

    // 4. config + start script
    onStep("writing gateway config...")
    renderConfig(app)
    File(root, "start_gateway.sh").writeText(startScript())
    File(root, ".installed").writeText("v1 ${arch()}")
    onStep("done")
  }

  /**
   * v2 one-shot install (aarch64): downloads the prebuilt image (Debian +
   * Python 3.14 + hermes-agent baked), verifies sha256 against the live
   * .sha256 asset, extracts, and finishes. No apt/pip/DNS inside proot.
   */
  private suspend fun installImage(app: Context, onStep: (String) -> Unit) {
    val root = rootDir(app)
    root.mkdirs()
    hermesHome(app).mkdirs()
    // INSTALL-04: refuse before the ~305MB download when storage is short.
    requireStorage(app, onStep)

    // proot must come bundled (exec-safe); the .deb fallback stays legacy-only.
    val proot = prootFile(app)
    onStep("proot: ${proot.absolutePath}")
    if (!stageBundledLibs(app)) onStep("warning: bundled proot libs not found")
    if (!proot.canExecute())
      throw RuntimeException("bundled proot missing/not executable, reinstall the app")
    onStep("proot ready")

    // Clean slate: a half-extracted legacy rootfs must never mix with the image.
    val fs = rootfsDir(app)
    if (!File(fs, ".image_ok").exists()) {
      if (fs.exists()) {
        onStep("clearing previous rootfs...")
        fs.deleteRecursively()
      }
      val tmp = File(root, "hermes-image.tar.gz")
      try {
        onStep("downloading prebuilt image (~305MB, one time)...")
        // INSTALL-02: labeled manifest entry wins; pin disagreement fails closed.
        // downloadTo still enforces the pin; the live .sha256 cross-check
        // below stays as the second gate (pinned vs live must agree).
        val (imageUrl, imageSha) = resolveImageAsset()
        if (imageUrl != IMAGE_AARCH64_URL) onStep("image: using manifest asset")
        downloadTo(imageUrl, tmp, imageSha,
          { pct -> onStep("downloading image... $pct%") },
          { msg -> onStep("image: $msg") },
          fallback = null)
        onStep("verifying checksum...")
        val want = fetchText(IMAGE_AARCH64_SHA_URL).split(Regex("\\s+")).firstOrNull().orEmpty()
        if (want.length < 32)
          throw RuntimeException("could not read image checksum, check network then retry")
        val actual = sha256File(tmp)
        if (!actual.equals(want, ignoreCase = true)) {
          tmp.delete()
          throw ChecksumException("image checksum mismatch (got $actual, want $want)")
        }
        if (!actual.equals(IMAGE_AARCH64_SHA, ignoreCase = true)) {
          tmp.delete()
          throw ChecksumException(
            "image checksum mismatch vs pinned build (got $actual, want $IMAGE_AARCH64_SHA). " +
              "Upstream rotated the image, update the pin."
          )
        }
        onStep("checksum OK")
        onStep("extracting image (one time, slow)...")
        extractTarXz(tmp, fs, "",
          { n -> if (n % 2000 == 0) onStep("extracting... $n files") },
          { m -> onStep(m) }, gz = true)
        // The tar excludes root/ (only held the pack script): recreate the
        // dirs the gateway expects before the first run.
        File(fs, "root").mkdirs()
        File(fs, "tmp").mkdirs()
        File(fs, ".rootfs_ok").writeText("bookworm aarch64 one-shot")
        File(fs, ".image_ok").writeText(IMAGE_VERSION)
      } finally {
        tmp.delete()
      }
    } else onStep("prebuilt image ready")

    val bad = verifyRootfs(fs)
    if (bad.isEmpty()) {
      onStep("rootfs check: loader + libc OK")
    } else {
      bad.take(8).forEach { onStep("rootfs MISSING: $it") }
      File(fs, ".image_ok").delete()
      File(fs, ".rootfs_ok").delete()
      throw RuntimeException(
        "image incomplete (${bad.size} gaps, see MISSING lines), retry re-downloads it"
      )
    }

    onStep("writing gateway config...")
    renderConfig(app)
    File(root, "start_gateway.sh").writeText(startScript())
    File(root, ".installed").writeText("v2 aarch64 one-shot")
    onStep("done")
  }

  private fun fetchText(url: String): String {
    val c = (URL(url).openConnection() as HttpURLConnection).apply {
      connectTimeout = 15_000; readTimeout = 30_000; instanceFollowRedirects = true
    }
    c.connect()
    if (c.responseCode !in 200..299)
      throw RuntimeException("fetch failed HTTP ${c.responseCode} for $url")
    return c.inputStream.bufferedReader().readText()
  }

  /** Re-renders config.yaml from the keys saved in the Setup tab. Called on every Start.
   *  Shape mirrors a real config.yaml: model.{provider,default},
   *  providers.<name>.{api_key,base_url}. Bot tokens + api-server bind
   *  travel as env vars (TELEGRAM_BOT_TOKEN, API_SERVER_*), like the PC setup. */
  /** Registry api-key provider ids (hermes_cli/auth.py): their key travels
   *  via env only; never write api_key under providers: for these (dead +
   *  plaintext secret). Named-custom providers keep both lines. */
  private val REGISTRY_API_KEY_IDS = setOf(
    "openai-api", "lmstudio", "copilot", "gemini", "zai", "kimi-coding",
    "kimi-coding-cn", "stepfun", "arcee", "gmi", "actual", "minimax",
    "anthropic", "alibaba", "alibaba-coding-plan", "minimax-cn", "deepseek",
    "xai", "nvidia", "ai-gateway", "opencode-zen", "opencode-go", "kilocode",
    "huggingface", "xiaomi", "tencent-tokenhub", "tencent-tokenplan",
    "ollama-cloud", "azure-foundry"
  )

  fun renderConfig(app: Context) {
    val p = app.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
    val provider = normProvider(p.getString("provider_name", "deepseek").orEmpty()).ifBlank { "deepseek" }
    val key = SecurePrefs.getString(app, SecurePrefs.KEY_PROVIDER, "")
    val baseUrl = p.getString("provider_base_url", "").orEmpty()
    val model = p.getString("model_id", "").orEmpty().ifBlank { "default" }
    // server_key: auto-issued random once below (local API never unintentionally open).
    // Secrets live in the encrypted store (SecurePrefs migrates legacy cleartext).
    var serverKey = SecurePrefs.getString(app, SecurePrefs.KEY_SERVER, "")
    if (serverKey.isBlank()) {
      val rnd = ByteArray(24)
      SecureRandom().nextBytes(rnd)
      serverKey = rnd.joinToString("") { "%02x".format(it) }
      SecurePrefs.putString(app, SecurePrefs.KEY_SERVER, serverKey)
    }
    // Fail-closed guard (audit hardening): never write a config with an empty
    // server key (that would leave the local API unintentionally open).
    if (serverKey.isBlank())
      throw IllegalStateException("server key mint failed, refusing to write config with empty key")
    val cfg = configTemplate()
      .replace("__PROVIDER__", provider)
      .replace("__MODEL__", model)
      // Registry ids read their key from env (service export); writing api_key
      // for them is dead config plus a plaintext secret. Customs need it.
      // NOTE: expand __API_KEY_LINE__ FIRST: its expansion contains a literal
      // __API_KEY__ placeholder, so the key substitution must run after it,
      // otherwise the literal key placeholder is baked into config.yaml.
      .replace("__API_KEY_LINE__",
        if (normProvider(provider) in REGISTRY_API_KEY_IDS) ""
        else "\n        api_key: \"__API_KEY__\"")
      .replace("__API_KEY__", key.replace("\\", "\\\\").replace("\"", "\\\"")
        .replace("\n", "").replace("\r", ""))
      .replace("__BASE_URL_LINE__", if (baseUrl.isNotBlank()) "\n        base_url: \"$baseUrl\"" else "")
      .replace("__MODEL_BASE_URL_LINE__", if (baseUrl.isNotBlank()) "\n      base_url: \"$baseUrl\"" else "")
    File(rootDir(app), "config.yaml").writeText(cfg)
  }

  /**
   * proot hardening for new kernels (S25/Android 16 hits seccomp EPERM on the
   * traced execve; pure-ptrace mode + a writable tmp dir it can canonicalize).
   */
  fun prootEnv(app: Context): Map<String, String> {
    val tmp = File(app.cacheDir, "proot-tmp").apply { mkdirs() }
    return mapOf("PROOT_NO_SECCOMP" to "1", "PROOT_TMP_DIR" to tmp.absolutePath)
  }
  /** Runs a shell command inside the rootfs via proot. Returns exit code. */
  fun runProot(app: Context, shellCmd: String, timeoutMs: Long = 30 * 60 * 1000): Int {
    val proot = prootFile(app).absolutePath
    val pf = File(proot)
    // Fail loud with the real cause instead of a bare IOException up the stack.
    require(pf.exists()) { "proot binary missing at $proot (reinstall the app)" }
    require(pf.canExecute()) {
      "proot at $proot is not executable (SELinux exec denial? reinstall the app)"
    }
    val fs = rootfsDir(app).absolutePath
    val home = hermesHome(app).absolutePath
    val pb = ProcessBuilder(
      proot, "-r", fs,
      "-b", "/dev", "-b", "/proc", "-b", "/sys",
      "-b", "$home:/root",
      "-w", "/root",
      "/usr/bin/sh", "-c", shellCmd
    )
    pb.environment()["HERMES_HOME"] = "/root"
    pb.environment()["PYTHONIOENCODING"] = "utf-8"
    pb.environment()["DEBIAN_FRONTEND"] = "noninteractive"
    pb.environment()["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    pb.environment()["LD_LIBRARY_PATH"] = File(prootPkgDir(app), "lib").absolutePath
    for ((k, v) in prootEnv(app)) pb.environment()[k] = v
    // Skip proot's temp-file loader extraction (fails under app SELinux):
    // point it at the bundled static loaders in the APK lib dir instead.
    prootLoaderFile(app)?.let {
      pb.environment()["PROOT_LOADER"] = it.absolutePath
    }
    prootLoader32File(app)?.let { pb.environment()["PROOT_LOADER_32"] = it.absolutePath }
    pb.redirectErrorStream(true)
    val proc = pb.start()
    val out = File(rootDir(app), "bootstrap_last.log")
    proc.inputStream.copyTo(out.outputStream())
    val finished = proc.waitFor(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
    if (!finished) { proc.destroyForcibly(); return 124 }
    return proc.exitValue()
  }

  private class ChecksumException(msg: String) : RuntimeException(msg)

  /**
   * Download with 3 attempts + backoff and a MANDATORY SHA-256 pin check
   * (fail closed: a blank pin is rejected before any bytes are fetched).
   * An optional fallback resolver may supply a mirror URL when the pinned
   * URL 404s; the mirror must carry the same pin or the download is refused
   * instead of fetched unverified. Checksum mismatches fail fast (no point
   * re-downloading a wrong file).
   */
  /** Mirror/fallback target: a replacement URL plus the SHA-256 pin that
   *  still covers it. A null pin means the replacement cannot be verified
   *  and downloadTo refuses it (fail closed) instead of fetching unverified. */
  data class FallbackTarget(val url: String, val sha256: String?)

  private fun downloadTo(
    url: String,
    dest: File,
    expectedSha: String,
    onPct: (Int) -> Unit,
    onLog: (String) -> Unit,
    fallback: (() -> FallbackTarget?)?
  ) {
    require(expectedSha.isNotBlank()) {
      "refusing to download $url without a pinned SHA-256 (fail closed)"
    }
    val sha: String = expectedSha
    var lastErr: Exception? = null
    var attemptUrl = url
    repeat(3) { attempt ->
      try {
        fetchUrl(attemptUrl, dest, onPct)
        val actual = sha256File(dest)
        if (!actual.equals(sha, ignoreCase = true)) {
          dest.delete()
          throw ChecksumException(
            "checksum mismatch for $attemptUrl (got $actual, want $sha). " +
              "Upstream rotated the file, update the pin."
          )
        }
        onLog("checksum OK")
        return
      } catch (e: ChecksumException) {
        throw e
      } catch (e: Exception) {
        lastErr = e
        // Pinned URL dead? A mirror of the SAME bytes may retry with the pin
        // intact. Anything else (e.g. an index-re-resolved .deb for a rotated
        // file) carries no valid pin and is refused, never fetched unverified.
        if (fallback != null && (e.message ?: "").contains("HTTP 404")) {
          val alt = try {
            fallback()
          } catch (e2: Exception) {
            onLog("fallback lookup failed: ${e2.message}")
            null
          }
          if (alt != null && alt.url != attemptUrl) {
            if (alt.sha256.isNullOrBlank())
              throw RuntimeException(
                "pinned URL 404 and the replacement ${alt.url} has no " +
                  "checksum pin, refusing unverified download"
              )
            if (!alt.sha256.equals(sha, ignoreCase = true))
              throw RuntimeException(
                "pinned URL 404 and the replacement pin does not match, " +
                  "refusing download (update the pin)"
              )
            onLog("pinned URL 404, retrying via mirror ${alt.url}")
            attemptUrl = alt.url
          }
        }
        if (attempt < 2) {
          onLog("attempt ${attempt + 1} failed (${e.message}), retrying...")
          Thread.sleep((attempt + 1) * 3_000L)
        }
      }
    }
    throw RuntimeException("download failed after 3 attempts: ${lastErr?.message}")
  }

  private fun fetchUrl(url: String, dest: File, onPct: (Int) -> Unit) {
    val c = (URL(url).openConnection() as HttpURLConnection).apply {
      connectTimeout = 15_000; readTimeout = 60_000; instanceFollowRedirects = true
    }
    c.connect()
    if (c.responseCode !in 200..299)
      throw RuntimeException("download failed HTTP ${c.responseCode} for $url")
    val total = c.contentLengthLong
    BufferedInputStream(c.inputStream).use { input ->
      FileOutputStream(dest).use { output ->
        val buf = ByteArray(64 * 1024)
        var done = 0L
        var lastPct = -1
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          output.write(buf, 0, n)
          done += n
          if (total > 0) {
            val pct = ((done * 100) / total).toInt()
            if (pct != lastPct) { lastPct = pct; onPct(pct) }
          }
        }
      }
    }
  }

  private fun sha256File(f: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    f.inputStream().buffered().use { ins ->
      val buf = ByteArray(256 * 1024)
      while (true) {
        val n = ins.read(buf)
        if (n < 0) break
        md.update(buf, 0, n)
      }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
  }

  /**
   * Parses the live Termux Packages index to find the current .deb for a
   * package. The resolved file is NOT covered by any recorded pin, so the
   * target carries a null digest and downloadTo refuses it (fail closed);
   * the URL survives only for the refusal message. Record a pin in debUrls()
   * to actually enable a new file.
   */
  private fun resolveDebFromIndex(aptPackage: String): FallbackTarget? {
    val index = "https://packages.termux.dev/apt/termux-main/dists/stable/main/binary-${arch()}/Packages"
    val c = (URL(index).openConnection() as HttpURLConnection).apply {
      connectTimeout = 15_000; readTimeout = 30_000; instanceFollowRedirects = true
    }
    c.connect()
    if (c.responseCode !in 200..299) return null
    val text = c.inputStream.bufferedReader().readText()
    var wantFile: String? = null
    var inBlock = false
    for (line in text.lineSequence()) {
      if (line.isBlank()) { inBlock = false; continue }
      if (line.startsWith("Package: ")) inBlock = (line.removePrefix("Package: ").trim() == aptPackage)
      else if (inBlock && line.startsWith("Filename: ")) {
        wantFile = line.removePrefix("Filename: ").trim()
        break
      }
    }
    return wantFile?.let {
      FallbackTarget("https://packages.termux.dev/apt/termux-main/$it", null)
    }
  }

  /**
   * One-line hint for the install log tail. Covers the two failure modes the
   * legacy path hits most: no DNS inside the rootfs (apt/pip report
   * "Temporary failure resolving ...") and the LMK killing a big download or
   * unpack ("killed", OOM). Returns null when no known needle matches.
   * Pure function, no Android dependencies. Download logic is untouched.
   */
  fun installFailureHint(logText: String): String? {
    val t = logText.lowercase()
    if ("temporary failure resolving" in t || "temporary failure in name resolution" in t)
      return "no DNS inside the installer (Temporary failure resolving): check connection, then Retry install"
    if ("killed" in t || "out of memory" in t || "oom" in t ||
      "cannot allocate memory" in t || "process killed" in t)
      return "installer was killed (out of memory): free RAM, then Retry install"
    return null
  }

  /**
   * Host-side rootfs health check (no proot needed): proves the guest loader
   * chain exists before we try to run anything. Returns missing entries.
   * proot's "interpreter not found" always traces back to one of these.
   */
  fun verifyRootfs(fs: File): List<String> {
    val missing = mutableListOf<String>()
    val need = listOf("usr/bin/sh", "bin", "lib", "usr/lib", "etc")
    for (rel in need) {
      val f = File(fs, rel)
      if (!f.exists()) missing += "$rel (absent)"
    }
    // The actual ELF loader proot needs, e.g. usr/lib/ld-linux-aarch64.so.1.
    val ld = File(fs, "usr/lib").listFiles { f -> f.name.startsWith("ld-linux") }
    if (ld.isNullOrEmpty()) missing += "usr/lib/ld-linux* (no guest loader)"
    val libc = File(fs, "usr/lib/aarch64-linux-gnu").listFiles { f ->
      f.name.startsWith("libc.so")
    } ?: File(fs, "usr/lib/arm-linux-gnueabihf").listFiles { f ->
      f.name.startsWith("libc.so")
    } ?: File(fs, "usr/lib/x86_64-linux-gnu").listFiles { f ->
      f.name.startsWith("libc.so")
    }
    if (libc.isNullOrEmpty()) missing += "libc.so.* (guest libc)"
    // Dangling usrmerge symlinks (lib -> usr/lib etc.) break every guest path.
    // NOTE: File.exists() follows links, so a dangling link reports false:
    // test isSymbolicLink first, then resolve the raw target by hand.
    for (rel in listOf("bin", "lib", "sbin", "lib64")) {
      val f = File(fs, rel)
      if (!java.nio.file.Files.isSymbolicLink(f.toPath())) continue
      try {
        val link = java.nio.file.Files.readSymbolicLink(f.toPath()).toString()
        val ok = File(f.parentFile, link).exists() ||
          File(fs, link.removePrefix("/")).exists()
        if (!ok) missing += "$rel (dangling symlink -> $link)"
      } catch (_: Exception) { missing += "$rel (unreadable symlink)" }
    }
    return missing
  }

  /**
   * Writes a support bundle to Download/hermes-install-log.txt: arch, proot
   * path, rootfs verify, lib/link listing, and the full last proot output.
   * Returns a short human message for the screen. pull via:
   * adb pull /sdcard/Download/hermes-install-log.txt
   */
  fun exportInstallLog(app: Context): String {
    val sb = StringBuilder()
    sb.appendLine("arch=" + arch() + " abi=" + Build.SUPPORTED_ABIS.joinToString(","))
    sb.appendLine("sdk=" + Build.VERSION.SDK_INT)
    val proot = prootFile(app)
    sb.appendLine("proot=" + proot.absolutePath + " exists=" + proot.exists() +
      " exec=" + proot.canExecute())
    val fs = rootfsDir(app)
    sb.appendLine("rootfs=" + fs.absolutePath)
    val bad = try { verifyRootfs(fs) } catch (e: Exception) {
      listOf("verify crashed: ${e.message}")
    }
    if (bad.isEmpty()) sb.appendLine("verify: OK") else bad.forEach {
      sb.appendLine("verify MISSING: $it")
    }
    fun describe(f: File): String {
      val p = f.toPath()
      val link = try {
        if (java.nio.file.Files.isSymbolicLink(p))
          " -> " + java.nio.file.Files.readSymbolicLink(p) else ""
      } catch (e: Exception) { " (link? ${e.message})" }
      return f.name + link + " size=" + f.length()
    }
    for (rel in listOf("", "lib", "usr/lib", "usr/bin", "bin")) {
      val d = if (rel.isEmpty()) fs else File(fs, rel)
      sb.appendLine("--- ls $rel ---")
      try {
        (d.listFiles()?.sortedBy { it.name }?.take(60) ?: emptyList())
          .forEach { sb.appendLine(describe(it)) }
      } catch (e: Exception) { sb.appendLine("ls failed: ${e.message}") }
    }
    sb.appendLine("--- bootstrap_last.log ---")
    try {
      sb.append(File(rootDir(app), "bootstrap_last.log").readText().take(20000))
    } catch (e: Exception) { sb.appendLine("no log: ${e.message}") }
    sb.appendLine("--- gateway.log (service) ---")
    try {
      // Reader matches the writer: the service drains proc output to
      // rootDir/gateway.log (startGateway), not logs/gateway.log.
      sb.append(File(rootDir(app), "gateway.log").readText().takeLast(8000))
    } catch (e: Exception) { sb.appendLine("no gateway.log yet: ${e.message}") }
    val text = sb.toString()
    val name = "hermes-install-log.txt"
    if (Build.VERSION.SDK_INT >= 29) {
      val values = android.content.ContentValues().apply {
        put(android.provider.MediaStore.Downloads.DISPLAY_NAME, name)
        put(android.provider.MediaStore.Downloads.MIME_TYPE, "text/plain")
      }
      val uri = app.contentResolver.insert(
        android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values
      ) ?: throw RuntimeException("media insert failed")
      app.contentResolver.openOutputStream(uri)!!.bufferedWriter().use {
        it.write(text)
      }
      return "log saved: Download/$name"
    }
    val out = File(
      android.os.Environment.getExternalStoragePublicDirectory(
        android.os.Environment.DIRECTORY_DOWNLOADS), name)
    out.writeText(text)
    return "log saved: ${out.absolutePath}"
  }

  /** Pulls data.tar.xz out of a Termux .deb and unpacks it under dest. */
  private fun extractDeb(deb: File, dest: File) {
    dest.mkdirs()
    deb.inputStream().buffered().use { fis ->
      ArArchiveInputStream(fis).use { ar ->
        var entry = ar.nextEntry
        while (entry != null) {
          if (entry.name == "data.tar.xz") {
            val tmp = File.createTempFile("proot-data", ".tar.xz", dest)
            try {
              FileOutputStream(tmp).use { fos -> ar.copyTo(fos) }
              extractTarXz(tmp, dest, "./data/data/com.termux/files/usr/", {}, {})
            } finally {
              tmp.delete()
            }
            return
          }
          entry = ar.nextEntry
        }
        throw RuntimeException("data.tar.xz not found in .deb")
      }
    }
  }

  private fun extractTarXz(
    archive: File, dest: File, stripPrefix: String,
    onCount: (Int) -> Unit = {}, onLog: (String) -> Unit = {},
    gz: Boolean = false
  ) {
    dest.mkdirs()
    val destCanon = dest.canonicalPath
    // Guest-anchored path: hardlink targets may be absolute (/usr/bin/x) or
    // ./-prefixed; File(dest, absoluteChild) would escape to the host fs.
    fun guestFile(raw: String): File {
      var r = raw.removePrefix("./")
      while (r.startsWith("/")) r = r.drop(1)
      val f = File(dest, r)
      // Reject ../ escapes: real Debian tars never emit them; fail the link
      // loudly (pending -> throw) instead of resolving outside the rootfs.
      val canon = try { f.canonicalPath } catch (_: Exception) { return f }
      require(canon == destCanon || canon.startsWith(destCanon + File.separator)) {
        "link target escapes rootfs: $raw"
      }
      return f
    }
    data class PendingLink(val out: File, val target: File, val symlink: Boolean, val rawTarget: String, val mode: Int)
    val pending = mutableListOf<PendingLink>()
    archive.inputStream().buffered().use { fis ->
      val comp: java.io.InputStream =
        if (gz) GzipCompressorInputStream(fis) else XZCompressorInputStream(fis)
      comp.use { xz ->
        TarArchiveInputStream(xz).use { tar ->
          var entry = tar.nextEntry
          var n = 0
          val buf = ByteArray(64 * 1024)
          while (entry != null) {
            var name = entry.name
            if (stripPrefix.isNotEmpty()) {
              if (!name.startsWith(stripPrefix)) { entry = tar.nextEntry; continue }
              name = name.removePrefix(stripPrefix)
              if (name.isEmpty()) { entry = tar.nextEntry; continue }
            }
            val out = File(dest, name)
            // zip-slip guard (real archives verified clean, latent only)
            if (!out.canonicalPath.startsWith(destCanon)) { entry = tar.nextEntry; continue }
            if (entry.isDirectory) {
              out.mkdirs()
            } else if (entry.isSymbolicLink) {
              out.parentFile?.mkdirs()
              out.delete()
              try {
                java.nio.file.Files.createSymbolicLink(out.toPath(), java.nio.file.Paths.get(entry.linkName))
              } catch (e: Exception) {
                // Retry after the full pass (parent dirs may arrive later in the tar).
                pending += PendingLink(out, guestFile(entry.linkName), true, entry.linkName, entry.mode)
              }
            } else if (entry.isLink) {
              out.parentFile?.mkdirs()
              out.delete()
              try {
                java.nio.file.Files.createLink(out.toPath(), guestFile(entry.linkName).toPath())
              } catch (e: Exception) {
                // Classic tar-ordering failure: link target not extracted yet.
                // Defer, do NOT abort 10k extracted files over one link.
                pending += PendingLink(out, guestFile(entry.linkName), false, entry.linkName, entry.mode)
              }
            } else {
              out.parentFile?.mkdirs()
              FileOutputStream(out).use { fos ->
                while (true) {
                  val r = tar.read(buf)
                  if (r < 0) break
                  fos.write(buf, 0, r)
                }
              }
              // keep Unix exec bits (rootfs ships 0777 dash/apt; default 644 would not run)
              val mode = entry.mode
              if (mode and 0b001_000_000 != 0) out.setExecutable(true, false)
              if (mode and 0b100_000_000 != 0) out.setReadable(true, false)
              if (mode and 0b010_000_000 != 0) out.setWritable(true, false)
            }
            n++
            onCount(n)
            entry = tar.nextEntry
          }
        }
      }
    }
    // Second pass: links deferred because their target was not on disk yet.
    if (pending.isNotEmpty()) {
      onLog("linking ${pending.size} deferred entries...")
      val failed = mutableListOf<String>()
      for (p in pending) {
        try {
          p.out.parentFile?.mkdirs()
          p.out.delete()
          if (p.symlink) {
            java.nio.file.Files.createSymbolicLink(p.out.toPath(), java.nio.file.Paths.get(p.rawTarget))
          } else {
            java.nio.file.Files.createLink(p.out.toPath(), p.target.toPath())
          }
        } catch (e: Exception) {
          // Last resort for hardlinks: byte-copy the target (same content,
          // loses inode sharing, install proceeds). Symlinks must be real.
          // Carry the entry's exec bit across the copy so copied binaries run.
          try {
            if (!p.symlink && p.target.isFile) {
              java.nio.file.Files.copy(p.target.toPath(), p.out.toPath())
              if (p.mode and 0b001_000_000 != 0) p.out.setExecutable(true, false)
              if (p.mode and 0b100_000_000 != 0) p.out.setReadable(true, false)
            } else throw e
          } catch (e2: Exception) {
            failed += "${p.out} -> ${p.rawTarget}: ${e.message} / copy: ${e2.message}"
          }
        }
      }
      if (failed.isNotEmpty()) {
        throw RuntimeException(
          "extraction failed on ${failed.size} links (first: ${failed.first()})"
        )
      }
      onLog("links resolved")
    }
  }

  fun configTemplate(): String = """
    # Hermes Mobile on-phone gateway (user fills keys in app UI, no defaults).
    # NOTE: registry providers (deepseek, openai...) read their key from env
    # (e.g. DEEPSEEK_API_KEY, exported by the app service), NOT from api_key
    # below. api_key + base_url here fund named-custom providers; model.base_url
    # routes built-in providers through a proxy.
    model:
      provider: "__PROVIDER__"
      default: "__MODEL__"__MODEL_BASE_URL_LINE__
    providers:
      __PROVIDER__:__API_KEY_LINE____BASE_URL_LINE__
    platforms:
      api_server: {host: 127.0.0.1, port: 8080}
  """.trimIndent()

  fun startScript(): String = """
    #!/bin/sh
    # Manual-debug helper: re-enters the rootfs the same way MobileGatewayService
    # does (paths below are guest paths; replace HOST_* when running by hand).
    # The service itself builds this argv in code and does not exec this file.
    # Manual recipe (replace the HOST_* dirs with real host paths):
    #   proot -r HOST_ROOT/rootfs -b /dev -b /proc -b /sys
    #     -b HOST_HOME:/root -w /root /usr/bin/sh -c
    #     'export HERMES_HOME=/root PYTHONIOENCODING=utf-8 DEBIAN_FRONTEND=noninteractive
    #      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    #      LD_LIBRARY_PATH=HOST_PKG/lib
    #      API_SERVER_HOST=127.0.0.1 API_SERVER_PORT=8080 API_SERVER_KEY=KEY
    #      PROVIDER_KEY_ENV=KEY TELEGRAM_BOT_TOKEN=TOKEN DISCORD_BOT_TOKEN=TOKEN
    #      exec python3 -m hermes_cli.main gateway run'
    export HERMES_HOME=/root PYTHONIOENCODING=utf-8
    exec python3 -m hermes_cli.main gateway run
  """.trimIndent()
}
