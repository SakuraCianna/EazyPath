package com.eazypath

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.navigation.compose.rememberNavController
import com.eazypath.data.EazyPathRepository
import com.eazypath.ui.navigation.EazyPathNavGraph
import com.eazypath.ui.theme.EazyPathTheme
import com.eazypath.ui.viewmodels.MainViewModel

class MainActivity : ComponentActivity() {
    private val repository by lazy { EazyPathRepository(applicationContext) }
    private val viewModel by viewModels<MainViewModel> { MainViewModel.factory(repository) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            EazyPathTheme {
                EazyPathNavGraph(
                    navController = rememberNavController(),
                    viewModel = viewModel,
                )
            }
        }
    }
}
