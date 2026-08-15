import { IntelligenceReport } from '../types';
import { generateIntelligenceReportClaude, extractTextFromImageClaude } from './anthropicService';
import { generateIntelligenceReport as generateIntelligenceReportGemini, extractTextFromImage as extractTextFromImageGemini, crossCheckReport } from './geminiService';

// Anthropic (Claude) is the primary provider; Gemini is the fallback.
// When GEMINI_API_KEY is present, Gemini also cross-checks Claude's findings.

export const generateIntelligenceReport = async (
  personName: string,
  company: string,
  additionalLinks?: string[]
): Promise<{ report: IntelligenceReport; sources: any[] }> => {
  let result: { report: IntelligenceReport; sources: any[] };

  try {
    result = await generateIntelligenceReportClaude(personName, company, additionalLinks);
  } catch (error) {
    console.error('[INTELLIGENCE] Claude failed, falling back to Gemini:', error instanceof Error ? error.message : error);
    return await generateIntelligenceReportGemini(personName, company, additionalLinks);
  }

  // Optional Gemini cross-check — only runs when GEMINI_API_KEY is configured
  if (process.env.GEMINI_API_KEY) {
    try {
      console.log('[INTELLIGENCE] Running Gemini cross-check on Claude report…');
      const verification = await crossCheckReport(result.report, personName, company);
      result.report = applyVerification(result.report, verification);
      console.log(
        `[INTELLIGENCE] Gemini cross-check complete — accuracy score: ${verification.overallAccuracyScore}, flags: ${verification.flags.length}`
      );
    } catch (verifyError) {
      // Cross-check is best-effort; never block the primary result
      console.warn('[INTELLIGENCE] Gemini cross-check skipped:', verifyError instanceof Error ? verifyError.message : verifyError);
    }
  }

  return result;
};

/**
 * Apply Gemini's verification flags to the report:
 * - Adjust confidence scores on flagged points
 * - Attach the VerificationResult for the UI to display
 */
function applyVerification(report: IntelligenceReport, verification: import('../types').VerificationResult): IntelligenceReport {
  const updated = { ...report, verification };

  for (const flag of verification.flags) {
    const section = updated[flag.section];
    if (!section || !Array.isArray(section.points)) continue;
    const point = section.points[flag.pointIndex];
    if (!point) continue;
    const adjusted = Math.max(0, Math.min(100, point.confidence + flag.confidenceAdjustment));
    section.points[flag.pointIndex] = { ...point, confidence: adjusted };
  }

  return updated;
}

export const extractTextFromImage = async (
  base64Image: string
): Promise<{ name: string; company: string }> => {
  try {
    return await extractTextFromImageClaude(base64Image);
  } catch (error) {
    console.error('[INTELLIGENCE] Claude card extraction failed, falling back to Gemini:', error instanceof Error ? error.message : error);
    return await extractTextFromImageGemini(base64Image);
  }
};
