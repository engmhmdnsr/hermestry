package ee.oversight.hermes.mobile.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Phase-1 typography.
 *
 * - UI text: modern sans-serif (FontFamily.Default / SansSerif).
 * - Monospace ONLY for code, terminal output, and headers/metadata.
 *
 * Sizes:
 * - Screen title 24-28sp, section 18-20sp, body 15-16sp,
 *   secondary 13-14sp, metadata 11-12sp.
 */
object AppType {
  val UiSans: FontFamily = FontFamily.Default
  val CodeMono: FontFamily = FontFamily.Monospace

  val ScreenTitle = TextStyle(
    fontFamily = UiSans,
    fontWeight = FontWeight.SemiBold,
    fontSize = 26.sp,
    lineHeight = 32.sp
  )
  val Section = TextStyle(
    fontFamily = UiSans,
    fontWeight = FontWeight.SemiBold,
    fontSize = 19.sp,
    lineHeight = 26.sp
  )
  val Body = TextStyle(
    fontFamily = UiSans,
    fontWeight = FontWeight.Normal,
    fontSize = 15.sp,
    lineHeight = 22.sp
  )
  val Secondary = TextStyle(
    fontFamily = UiSans,
    fontWeight = FontWeight.Normal,
    fontSize = 13.sp,
    lineHeight = 18.sp
  )
  val Metadata = TextStyle(
    fontFamily = CodeMono,
    fontWeight = FontWeight.Normal,
    fontSize = 12.sp,
    lineHeight = 16.sp
  )
  val Code = TextStyle(
    fontFamily = CodeMono,
    fontWeight = FontWeight.Normal,
    fontSize = 13.sp,
    lineHeight = 19.sp
  )
}

/** Material3 typography wired to the Phase-1 scale (sans-serif UI). */
val Phase1Typography = Typography(
  displaySmall = AppType.ScreenTitle,
  titleLarge = AppType.ScreenTitle,
  titleMedium = AppType.Section,
  bodyLarge = AppType.Body,
  bodyMedium = AppType.Secondary,
  labelSmall = AppType.Metadata
)
