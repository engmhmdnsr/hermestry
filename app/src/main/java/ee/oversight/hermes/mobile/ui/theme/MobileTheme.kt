package ee.oversight.hermes.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Same cyberpunk identity as Hermes Control.
val CyberBg = Color(0xFF080B10)
val CyberSurface = Color(0xFF11161D)
val CyberSurfaceElevated = Color(0xFF181F2A)
val CyberSurfaceBorder = Color(0xFF1F2937)
val CyberTerminalBg = Color(0xFF05080C)

val NeonViolet = Color(0xFF8B5CF6)
val NeonVioletLight = Color(0xFFA78BFA)
val NeonVioletDark = Color(0xFF6D28D9)
val NeonCyan = Color(0xFF06B6D4)
val NeonCyanLight = Color(0xFF22D3EE)
val NeonGreen = Color(0xFF10B981)
val NeonAmber = Color(0xFFF59E0B)
val NeonRed = Color(0xFFEF4444)

val TextPrimary = Color(0xFFF1F5F9)
val TextSecondary = Color(0xFF94A3B8)
val TextTerminal = Color(0xFF34D399)

private val MobileDarkScheme = darkColorScheme(
  primary = NeonViolet,
  onPrimary = Color.White,
  primaryContainer = Color(0xFF2E1065),
  onPrimaryContainer = NeonVioletLight,
  secondary = NeonCyan,
  onSecondary = Color.Black,
  secondaryContainer = Color(0xFF083344),
  onSecondaryContainer = NeonCyanLight,
  tertiary = NeonAmber,
  onTertiary = Color.Black,
  background = CyberBg,
  onBackground = TextPrimary,
  surface = CyberSurface,
  onSurface = TextPrimary,
  surfaceVariant = CyberSurfaceElevated,
  onSurfaceVariant = TextSecondary,
  outline = CyberSurfaceBorder,
  outlineVariant = Color(0xFF2D3748),
  error = NeonRed,
  onError = Color.White
)

@Composable
fun HermesMobileTheme(content: @Composable () -> Unit) {
  MaterialTheme(colorScheme = MobileDarkScheme, content = content)
}
