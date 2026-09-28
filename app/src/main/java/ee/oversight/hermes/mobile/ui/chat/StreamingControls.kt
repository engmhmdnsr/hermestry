package ee.oversight.hermes.mobile.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FlashOn
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceElevated
import ee.oversight.hermes.mobile.ui.theme.NeonAmber
import ee.oversight.hermes.mobile.ui.theme.NeonRed
import ee.oversight.hermes.mobile.ui.theme.NeonViolet
import ee.oversight.hermes.mobile.ui.theme.NeonVioletLight
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/**
 * Streaming action row, mirrors desktop ChatTerminalScreen streaming buttons.
 * Idle: nothing. Streaming + text: Queue (amber) + Send-now (violet) + Stop (red).
 * Streaming + empty: Stop only.
 */
@Composable
fun StreamingControls(
    isStreaming: Boolean,
    hasText: Boolean,
    onQueue: () -> Unit,
    onSendNow: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
    fontScale: Float = 1f
) {
    if (!isStreaming) return
    Row(
        modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(bottom = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (hasText) {
            OutlinedButton(onClick = onQueue) {
                Icon(Icons.Filled.ArrowDownward, "queue", tint = NeonAmber)
                Spacer(Modifier.width(4.dp))
                Text("Queue", color = NeonAmber, fontSize = (12 * fontScale).sp, fontFamily = FontFamily.Monospace)
            }
            OutlinedButton(onClick = onSendNow) {
                Icon(Icons.Filled.FlashOn, "send now", tint = NeonVioletLight)
                Spacer(Modifier.width(4.dp))
                Text("Send now", color = NeonVioletLight, fontSize = (12 * fontScale).sp, fontFamily = FontFamily.Monospace)
            }
        }
        OutlinedButton(onClick = onStop) {
            Icon(Icons.Filled.Close, "stop", tint = NeonRed)
            Spacer(Modifier.width(4.dp))
            Text("Stop", color = NeonRed, fontSize = (12 * fontScale).sp, fontFamily = FontFamily.Monospace)
        }
    }
}

/** Amber queued-message strip shown above the input; mirrors desktop queued banner. */
@Composable
fun QueuedBanner(
    count: Int,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier
) {
    if (count <= 0) return
    Row(
        modifier
            .fillMaxWidth()
            .background(NeonAmber.copy(alpha = 0.12f), RoundedCornerShape(8.dp))
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            "▼ $count queued",
            color = NeonAmber, fontSize = 12.sp,
            fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f)
        )
        TextButton(onClick = onCancel) {
            Text("Cancel", color = NeonRed, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
        }
    }
}

/**
 * Approval card placed ABOVE the input, mirroring desktop ApprovalCard placement.
 * Reuses [ApprovalScopesRow] for Once/Session/Always/Deny.
 */
@Composable
fun ApprovalOverInput(
    visible: Boolean,
    onAllow: (String) -> Unit,
    onDeny: () -> Unit,
    modifier: Modifier = Modifier
) {
    if (!visible) return
    Column(
        modifier
            .fillMaxWidth()
            .background(CyberSurfaceElevated, RoundedCornerShape(10.dp))
            .padding(10.dp)
    ) {
        Text(
            "◆ approval needed",
            color = NeonViolet, fontSize = 12.sp, fontFamily = FontFamily.Monospace
        )
        Text(
            "Agent requests permission to proceed.",
            color = TextSecondary, fontSize = 11.sp, fontFamily = FontFamily.Monospace
        )
        ApprovalScopesRow(onAllow = onAllow, onDeny = onDeny)
    }
}
