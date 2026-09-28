package ee.oversight.hermes.mobile.ui.theme

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * Agent status system for Phase-1.
 *
 * Status colors come from AppColors and are used ONLY for status display,
 * never for branding or general chrome.
 */
enum class AgentStatus(val label: String) {
  ONLINE("Online"),
  IDLE("Idle"),
  THINKING("Thinking"),
  EXECUTING("Executing"),
  WAITING_APPROVAL("Waiting"),
  OFFLINE("Offline"),
  CONNECTING("Connecting"),
  ERROR("Error")
}

/** Status dot/text color for each AgentStatus. */
fun AgentStatus.color(): Color = when (this) {
  AgentStatus.ONLINE -> AppColors.StatusOnline
  AgentStatus.IDLE -> AppColors.TextSecondary
  AgentStatus.THINKING -> AppColors.StatusThinking
  AgentStatus.EXECUTING -> AppColors.StatusExecuting
  AgentStatus.WAITING_APPROVAL -> AppColors.StatusWaiting
  AgentStatus.OFFLINE -> AppColors.StatusOffline
  AgentStatus.CONNECTING -> AppColors.StatusConnecting
  AgentStatus.ERROR -> AppColors.StatusError
}

/** Only CONNECTING and THINKING pulse. Everything else is static. */
fun AgentStatus.pulses(): Boolean = when (this) {
  AgentStatus.CONNECTING, AgentStatus.THINKING -> true
  else -> false
}

/**
 * Small status badge: colored dot + label on a flat surface.
 * No gradients, no glow. Subtle alpha pulse on the dot for
 * CONNECTING/THINKING only.
 */
@Composable
fun AgentStatusBadge(
  status: AgentStatus,
  modifier: Modifier = Modifier
) {
  var dotAlpha = 1f
  if (status.pulses()) {
    val transition = rememberInfiniteTransition(label = "AgentStatusPulse")
    val pulsed by transition.animateFloat(
      initialValue = 1f,
      targetValue = 0.35f,
      animationSpec = infiniteRepeatable(
        animation = tween(durationMillis = 900),
        repeatMode = RepeatMode.Reverse
      ),
      label = "AgentStatusAlpha"
    )
    dotAlpha = pulsed
  }

  Surface(
    modifier = modifier,
    shape = RoundedCornerShape(999.dp),
    color = AppColors.Surface2,
    border = BorderStroke(1.dp, AppColors.Border)
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
      verticalAlignment = Alignment.CenterVertically
    ) {
      Box(
        modifier = Modifier
          .size(8.dp)
          .alpha(dotAlpha)
          .background(status.color(), CircleShape)
      )
      Spacer(Modifier.width(6.dp))
      Text(
        text = status.label,
        style = AppType.Secondary,
        color = AppColors.TextSecondary
      )
    }
  }
}
