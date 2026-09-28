package ee.oversight.hermes.mobile.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.MobileViewModel
import ee.oversight.hermes.mobile.ui.theme.NeonCyan

@Composable
fun SettingsRoot(vm: MobileViewModel) {
  LazyColumn(
    Modifier.fillMaxSize().padding(16.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
    contentPadding = PaddingValues(bottom = 96.dp)
  ) {
    item {
      Text("// CONNECTION", color = NeonCyan, fontSize = 12.sp,
        fontFamily = FontFamily.Monospace)
      ConnSection(vm)
    }
    item {
      Text("// GATEWAY", color = NeonCyan, fontSize = 12.sp,
        fontFamily = FontFamily.Monospace)
      GatewaySection(vm)
    }
    item {
      Text("// CHAT", color = NeonCyan, fontSize = 12.sp,
        fontFamily = FontFamily.Monospace)
      ChatSection(vm)
    }
    item {
      Text("// LIBRARY", color = NeonCyan, fontSize = 12.sp,
        fontFamily = FontFamily.Monospace)
      LibrarySection(vm)
    }
  }
}
