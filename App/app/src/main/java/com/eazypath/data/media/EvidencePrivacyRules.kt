package com.eazypath.data.media

private val sensitiveTextPattern = Regex(
    "(?:1[3-9]\\d{9})|(?:\\d{17}[0-9Xx])|(?:[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z][A-Z0-9]{5,6})",
)

internal fun isSensitiveEvidenceText(text: String): Boolean =
    sensitiveTextPattern.containsMatchIn(text.replace(" ", ""))

internal fun evidencePartRanges(totalBytes: Int, partSize: Int = 1024 * 1024): List<IntRange> {
    require(totalBytes > 0)
    require(partSize > 0)
    return (0 until totalBytes step partSize).map { start -> start until minOf(start + partSize, totalBytes) }
}
