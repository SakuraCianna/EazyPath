package com.eazypath.data

internal fun reviewEvidenceBaseWeight(hasConfirmedRedactedImage: Boolean, locationProofPassed: Boolean): Double = when {
    !hasConfirmedRedactedImage -> 0.5
    locationProofPassed -> 1.0
    else -> 0.8
}
