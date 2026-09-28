package ee.oversight.hermes.mobile.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Phase-1 redesign palette (dark-first, flat, no gradients, no glassmorphism).
 *
 * Legacy values in MobileTheme.kt (CyberBg, Neon*, TextPrimary, ...) are left
 * intact for incremental migration. All new Phase-1 tokens live here under the
 * AppColors object so call sites can migrate file by file.
 *
 * Spec:
 * - Background #0B0D0F, Surface #12161A, Surface2 #181D22, Border #252B31
 * - Primary text #F1F3F5, Secondary text #9299A1
 * - One primary accent for identity: Violet (keeps the logo mark)
 * - Status colors are for status UI only, never for branding/chrome
 */
object AppColors {
  // Base surfaces
  val Background = Color(0xFF0B0D0F)
  val Surface = Color(0xFF12161A)
  val Surface2 = Color(0xFF181D22)
  val Border = Color(0xFF252B31)

  // Text
  val TextPrimary = Color(0xFFF1F3F5)
  val TextSecondary = Color(0xFF9299A1)

  // Identity: single primary accent (Violet, continuity with logo mark)
  val Accent = Color(0xFF8B5CF6)
  val AccentDim = Color(0xFF2E1065)
  val OnAccent = Color.White

  // Code / terminal surfaces (monospace contexts only)
  val CodeBackground = Color(0xFF0B0D0F)
  val CodeText = Color(0xFFE6E9EC)

  // Status colors: use ONLY for agent/message status, never for general UI
  val StatusOnline = Color(0xFF22C55E)
  val StatusThinking = Color(0xFF3B82F6)
  val StatusExecuting = Color(0xFFA855F7)
  val StatusWaiting = Color(0xFFF59E0B)
  val StatusError = Color(0xFFEF4444)
  val StatusOffline = Color(0xFF6B7280)
  val StatusConnecting = Color(0xFF60A5FA)
}
