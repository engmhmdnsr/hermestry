package ee.oversight.hermes.mobile.ui.settings

import android.content.Context
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.BuildConfig
import ee.oversight.hermes.mobile.MobileViewModel
import ee.oversight.hermes.mobile.ui.more.AboutScreen
import ee.oversight.hermes.mobile.ui.more.BlueprintLaunchCard
import ee.oversight.hermes.mobile.ui.more.BlueprintsDialog
import ee.oversight.hermes.mobile.ui.more.FeedbackForm
import ee.oversight.hermes.mobile.ui.more.MemoryScreen
import ee.oversight.hermes.mobile.ui.more.SkillsScreen
import ee.oversight.hermes.mobile.ui.more.VersionDetailsCard
import ee.oversight.hermes.mobile.ui.theme.CyberSurface
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonRed
import ee.oversight.hermes.mobile.ui.theme.NeonViolet
import ee.oversight.hermes.mobile.ui.theme.NeonVioletLight
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/**
 * Settings library section: About / Skills / Memory / Blueprints /
 * job-run history / Feedback / Tips, in that order. Wiring mirrors
 * MoreTab + JobsTab history block.
 */
@Composable
fun LibrarySection(vm: MobileViewModel, modifier: Modifier = Modifier) {
  val status by vm.status.collectAsState()
  val skills by vm.skills.collectAsState()
  val memory by vm.memory.collectAsState()
  val blueprints by vm.blueprints.collectAsState()
  val jobs by vm.jobs.collectAsState()
  val runs by vm.runs.collectAsState()
  var showBlueprints by remember { mutableStateOf(false) }
  var historyFor by remember { mutableStateOf<String?>(null) }
  // Persisted dismissal (same prefs file the vm uses; trivial, no vm change).
  val ctx = LocalContext.current
  val tipsPrefs = remember(ctx) {
    ctx.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
  }
  var tipsDismissed by remember { mutableStateOf(tipsPrefs.getBoolean("tips_dismissed", false)) }

  LaunchedEffect(Unit) {
    vm.refreshSkills()
    vm.refreshMemory()
    vm.refreshBlueprints()
    vm.refreshJobs()
  }

  Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
    // 1. About (imported)
    AboutScreen(
      appVersion = BuildConfig.VERSION_NAME,
      packageName = "ee.oversight.hermes.mobile",
      gatewayUrl = "http://127.0.0.1:8080",
      backend = status
    )
    VersionDetailsCard(
      appVersion = BuildConfig.VERSION_NAME,
      versionCode = BuildConfig.VERSION_CODE,
      packageName = "ee.oversight.hermes.mobile",
      backendVersion = status.version,
      gatewayUrl = "http://127.0.0.1:8080"
    )

    // 2. Skills (imported, wired)
    SkillsScreen(
      skills = skills,
      onToggle = { id, on -> vm.toggleSkill(id, on) },
      onRefresh = { vm.refreshSkills() }
    )

    // 3. Memory (imported, wired; read-only, no reset endpoint)
    MemoryScreen(
      info = memory,
      onRefresh = { vm.refreshMemory() }
    )

    // 4. Blueprints (wired + dialog)
    BlueprintLaunchCard(
      count = blueprints.size,
      onOpen = { vm.refreshBlueprints(); showBlueprints = true }
    )
    if (showBlueprints) {
      BlueprintsDialog(
        blueprints = blueprints,
        onInstantiate = { id, slots -> vm.instantiateBlueprint(id, slots) },
        onDismiss = { showBlueprints = false },
        onRefresh = { vm.refreshBlueprints() }
      )
    }

    // 5. Job-runs history (copied slim block from JobsTab history pattern)
    Card(
      colors = CardDefaults.cardColors(containerColor = CyberSurface),
      border = BorderStroke(1.dp, ee.oversight.hermes.mobile.ui.theme.CyberSurfaceBorder),
      modifier = Modifier.fillMaxWidth()
    ) {
      Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
          Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.SpaceBetween,
          verticalAlignment = Alignment.CenterVertically
        ) {
          Text(
            "// JOB-RUN HISTORY", color = NeonCyan, fontSize = 12.sp,
            fontFamily = FontFamily.Monospace
          )
          TextButton(onClick = { vm.refreshJobs() }) {
            Text("Refresh", color = NeonCyan, fontSize = 12.sp)
          }
        }
        if (jobs.isEmpty()) {
          Text("No jobs yet — history appears once a job exists.", color = TextSecondary, fontSize = 12.sp)
        } else {
          jobs.take(10).forEach { j ->
            Row(
              Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically
            ) {
              Text(
                j.name.ifBlank { j.id }, color = TextPrimary, fontSize = 13.sp,
                modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis
              )
              TextButton(onClick = {
                historyFor = if (historyFor == j.id) null else j.id
                vm.refreshRuns(j.id)
              }) {
                Text(
                  if (historyFor == j.id) "Hide" else "History",
                  color = TextSecondary, fontSize = 12.sp
                )
              }
            }
            if (historyFor == j.id) {
              val jobRuns = runs[j.id].orEmpty()
              if (jobRuns.isEmpty()) {
                Text("No runs recorded for this job yet.", color = TextSecondary, fontSize = 12.sp)
              } else {
                jobRuns.take(10).forEach { r ->
                  val errLine = r.error.lineSequence().firstOrNull { it.isNotBlank() }
                    ?.trim()?.take(160)
                  Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                    Text(
                      "\u2022 ${r.status.ifBlank { "?" }}${if (r.startedAt.isNotBlank()) " \u00b7 ${r.startedAt}" else ""}",
                      color = TextPrimary, fontSize = 12.sp, fontFamily = FontFamily.Monospace
                    )
                    if (!errLine.isNullOrBlank()) {
                      Text(
                        errLine, color = NeonRed, fontSize = 11.sp,
                        maxLines = 1, overflow = TextOverflow.Ellipsis
                      )
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // 6. Feedback (imported)
    FeedbackForm()

    // 7. Tips slim (copied from FirstRunTipsCard, 3 lines)
    if (!tipsDismissed) {
      Card(
        colors = CardDefaults.cardColors(containerColor = CyberSurface),
        modifier = Modifier.fillMaxWidth()
          .border(1.dp, NeonViolet.copy(alpha = 0.5f), RoundedCornerShape(10.dp))
      ) {
        Column(Modifier.padding(10.dp)) {
          Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
          ) {
            Text(
              "// TIPS", color = NeonCyan, fontSize = 12.sp,
              fontFamily = FontFamily.Monospace
            )
            TextButton(onClick = {
              tipsDismissed = true
              tipsPrefs.edit().putBoolean("tips_dismissed", true).apply()
            }) {
              Text("Got it", color = NeonVioletLight, fontSize = 12.sp)
            }
          }
          listOf(
            "\u00b7 Keys stay only on this phone.",
            "\u00b7 Gateway stuck? Stop \u2192 Start.",
            "\u00b7 Logs live in the System tab."
          ).forEach { tip ->
            Text(tip, color = TextSecondary, fontSize = 12.sp, maxLines = 1)
          }
        }
      }
    }
    Spacer(Modifier.height(0.dp))
  }
}
