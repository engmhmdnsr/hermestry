package ee.oversight.hermes.mobile.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceBorder
import ee.oversight.hermes.mobile.ui.theme.CyberTerminalBg
import ee.oversight.hermes.mobile.ui.theme.NeonVioletLight
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/**
 * Reasoning/thinking trace block, ported from Control ChatTerminalScreen ThinkingBlock.
 *
 * - Blank [thinking] renders nothing.
 * - While live ([done] == false): dimmed monospace preview (~7sp scaled) with a
 *   spinner next to the label.
 * - When done: collapsed row (arrow icon + label); tap expands the full text in a
 *   bordered dark box inside a [SelectionContainer] (~9.5sp scaled).
 */
@Composable
fun ThinkingBlock(
  thinking: String,
  done: Boolean,
  fontScale: Float = 1f,
  modifier: Modifier = Modifier
) {
  if (thinking.isBlank()) return

  if (!done) {
    Column(
      modifier = modifier
        .fillMaxWidth()
        .testTag("thinkingBlock")
    ) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(
          modifier = Modifier
            .size(12.dp)
            .testTag("thinkingSpinner"),
          color = NeonVioletLight,
          strokeWidth = 2.dp
        )
        Spacer(Modifier.width(6.dp))
        Text(
          "Thinking…",
          fontSize = (9.5f * fontScale).sp,
          color = NeonVioletLight,
          fontFamily = FontFamily.Monospace
        )
      }
      Text(
        thinking,
        fontSize = (7f * fontScale).sp,
        color = TextSecondary.copy(alpha = 0.7f),
        fontFamily = FontFamily.Monospace,
        modifier = Modifier
          .fillMaxWidth()
          .padding(top = 4.dp)
          .testTag("thinkingLive")
      )
    }
    return
  }

  var expanded by rememberSaveable { mutableStateOf(false) }
  Column(
    modifier = modifier
      .fillMaxWidth()
      .testTag("thinkingBlock")
  ) {
    Row(
      verticalAlignment = Alignment.CenterVertically,
      modifier = Modifier
        .clip(RoundedCornerShape(6.dp))
        .clickable { expanded = !expanded }
        .padding(vertical = 2.dp)
        .testTag("thinkingToggle")
    ) {
      Icon(
        if (expanded) Icons.Default.KeyboardArrowDown else Icons.Default.KeyboardArrowRight,
        contentDescription = if (expanded) "Collapse thinking" else "Expand thinking",
        tint = NeonVioletLight,
        modifier = Modifier.size(16.dp)
      )
      Spacer(Modifier.width(2.dp))
      Text(
        "Thinking",
        fontSize = (9.5f * fontScale).sp,
        color = NeonVioletLight,
        fontFamily = FontFamily.Monospace
      )
    }
    if (expanded) {
      SelectionContainer {
        Text(
          thinking,
          fontSize = (9.5f * fontScale).sp,
          color = TextSecondary,
          fontFamily = FontFamily.Monospace,
          modifier = Modifier
            .fillMaxWidth()
            .padding(top = 4.dp)
            .background(CyberTerminalBg, RoundedCornerShape(8.dp))
            .border(1.dp, CyberSurfaceBorder, RoundedCornerShape(8.dp))
            .padding(8.dp)
            .testTag("thinkingFull")
        )
      }
    }
  }
}
