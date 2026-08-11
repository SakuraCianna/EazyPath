package com.eazypath.ui.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.lifecycle.viewmodel.compose.viewModel as composeViewModel
import com.eazypath.data.EazyPathRepository
import com.eazypath.ui.screens.AccessibleMapScreen
import com.eazypath.ui.screens.CommunityReviewScreen
import com.eazypath.ui.screens.EvidenceSubmissionScreen
import com.eazypath.ui.screens.HomeScreen
import com.eazypath.ui.screens.ProfileScreen
import com.eazypath.ui.screens.TravelChainScreen
import com.eazypath.ui.screens.VerificationScreen
import com.eazypath.ui.viewmodels.MainViewModel
import com.eazypath.ui.viewmodels.MapViewModel
import java.net.URLDecoder
import java.net.URLEncoder

private sealed class Screen(val route: String) {
    data object Home : Screen("home")
    data object TravelChain : Screen("travel/{prompt}") {
        fun createRoute(prompt: String) = "travel/${URLEncoder.encode(prompt, Charsets.UTF_8.name())}"
    }
    data object Profile : Screen("profile")
    data object Verification : Screen("verification")
    data object Community : Screen("community")
    data object EvidenceSubmission : Screen("evidence-submission")
    data object Map : Screen("map")
}

@Composable
fun EazyPathNavGraph(
    navController: NavHostController,
    viewModel: MainViewModel,
    repository: EazyPathRepository,
) {
    NavHost(navController = navController, startDestination = Screen.Home.route) {
        composable(Screen.Home.route) {
            HomeScreen(
                viewModel = viewModel,
                onCreateTask = { navController.navigate(Screen.TravelChain.createRoute(it)) },
                onProfile = { navController.navigate(Screen.Profile.route) },
                onVerification = { navController.navigate(Screen.Verification.route) },
                onCommunity = { navController.navigate(Screen.Community.route) },
                onEvidenceSubmission = { navController.navigate(Screen.EvidenceSubmission.route) },
                onMap = { navController.navigate(Screen.Map.route) },
            )
        }
        composable(Screen.TravelChain.route) { entry ->
            val prompt = URLDecoder.decode(entry.arguments?.getString("prompt").orEmpty(), Charsets.UTF_8.name())
            TravelChainScreen(prompt, viewModel) { navController.popBackStack() }
        }
        composable(Screen.Profile.route) { ProfileScreen(viewModel) { navController.popBackStack() } }
        composable(Screen.Verification.route) { VerificationScreen(viewModel) { navController.popBackStack() } }
        composable(Screen.Community.route) { CommunityReviewScreen(viewModel) { navController.popBackStack() } }
        composable(Screen.EvidenceSubmission.route) { EvidenceSubmissionScreen(viewModel) { navController.popBackStack() } }
        composable(Screen.Map.route) {
            val mapViewModel: MapViewModel = composeViewModel(factory = MapViewModel.factory(repository))
            AccessibleMapScreen(
                viewModel = mapViewModel,
                onSubmitEvidence = { navController.navigate(Screen.EvidenceSubmission.route) },
                onCommunity = { navController.navigate(Screen.Community.route) },
                onBack = { navController.popBackStack() },
            )
        }
    }
}
