package com.eazypath.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eazypath.ui.viewmodels.MainViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CommunityReviewScreen(viewModel: MainViewModel, onBack: () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { viewModel.loadReviewTasks() }
    Scaffold(topBar = { TopAppBar(title = { Text("社区复核") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "返回") } }) }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Text("你可以回答存在、不存在或无法判断。未附现场脱敏图片和位置证明的基础权重为 0.5；同一轮只计一票。", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (state.reviewsLoading) item { Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) { CircularProgressIndicator(); Text("读取复核任务…") } }
            state.reviewsError?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
            if (!state.reviewsLoading && state.reviewTasks.isEmpty()) item { Text("当前没有待复核任务。系统不会生成演示任务。", Modifier.padding(24.dp)) }
            items(state.reviewTasks, key = { it.id }) { task ->
                Card(shape = RoundedCornerShape(18.dp)) { Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    Text(task.placeName, fontWeight = FontWeight.Black)
                    Text(task.featureName, color = MaterialTheme.colorScheme.primary)
                    Text(task.address ?: "地址待补充", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { viewModel.submitReview(task.id, "present") }, modifier = Modifier.weight(1f)) { Text("存在") }
                        OutlinedButton(onClick = { viewModel.submitReview(task.id, "absent") }, modifier = Modifier.weight(1f)) { Text("不存在") }
                        OutlinedButton(onClick = { viewModel.submitReview(task.id, "unknown") }, modifier = Modifier.weight(1f)) { Text("未知") }
                    }
                } }
            }
        }
    }
}
